import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import type { AgentRole, ModelRef, RoleBinding, TaskMode } from '@loom/shared';
import { createPaths } from './paths.ts';
import { RuntimeStore } from './store.ts';
import { MemoryService } from './memory.ts';
import { WorkspaceService } from './workspace.ts';
import { CcSwitchGateway } from './gateway.ts';
import { Orchestrator } from './orchestrator.ts';

const paths = createPaths();
const store = new RuntimeStore(paths.data);
const memory = new MemoryService(store, paths.data, paths.backups);
const gateway = new CcSwitchGateway();
const orchestrator = new Orchestrator(store, memory, new WorkspaceService(paths), gateway);
const port = Number(process.env.LOOM_RUNTIME_PORT || 3210);
const token = process.env.LOOM_RUNTIME_TOKEN || (process.env.NODE_ENV === 'production' ? randomBytes(24).toString('hex') : 'loom-development');
const clients = new Set<ServerResponse>();
const allowedOrigins = new Set(['http://127.0.0.1:1420', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);

orchestrator.subscribe(event => {
  const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(frame);
});

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function authenticate(request: IncomingMessage, url: URL): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
  return supplied === token;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'authorization,content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (url.pathname === '/health') return json(response, 200, { ok: true, version: '0.2.0' });
  if (origin && !allowedOrigins.has(origin)) return json(response, 403, { error: '来源不受信任' });
  if (!authenticate(request, url)) return json(response, 401, { error: '未授权' });

  try {
    if (request.method === 'GET' && url.pathname === '/api/snapshot') return json(response, 200, orchestrator.snapshot());
    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const after = Number(request.headers['last-event-id'] || url.searchParams.get('after') || 0);
      for (const event of store.events(after)) response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      clients.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/gateway/refresh') return json(response, 200, await orchestrator.refreshGateway());
    if (request.method === 'POST' && url.pathname === '/api/models') return json(response, 201, orchestrator.saveManualModel(await body(request) as unknown as ModelRef));
    if (request.method === 'POST' && url.pathname === '/api/credentials') {
      const input = await body(request);
      orchestrator.setCredential(String(input.reference || ''), String(input.secret || ''));
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/bindings') return json(response, 200, orchestrator.bindRole(await body(request) as unknown as RoleBinding));
    if (request.method === 'POST' && url.pathname === '/api/projects') {
      const input = await body(request);
      return json(response, 201, orchestrator.createProject({ title: String(input.title || ''), path: String(input.path || '') }));
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const input = await body(request);
      return json(response, 202, await orchestrator.createTask({
        projectId: typeof input.projectId === 'string' ? input.projectId : undefined,
        prompt: String(input.prompt || ''),
        mode: input.mode === 'direct' ? 'direct' : 'plan' as TaskMode,
        title: typeof input.title === 'string' ? input.title : undefined,
        roleOverrides: input.roleOverrides as Partial<Record<AgentRole, ModelRef>> | undefined,
      }));
    }
    const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/approve$/);
    if (request.method === 'POST' && planMatch?.[1]) return json(response, 200, await orchestrator.approvePlan(planMatch[1]));
    const commandMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve-command$/);
    if (request.method === 'POST' && commandMatch?.[1]) return json(response, 200, await orchestrator.approveCommand(commandMatch[1]));
    const dangerousMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve-dangerous$/);
    if (request.method === 'POST' && dangerousMatch?.[1]) return json(response, 200, await orchestrator.approveDangerous(dangerousMatch[1]));
    const rejectionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
    if (request.method === 'POST' && rejectionMatch?.[1]) return json(response, 200, orchestrator.rejectApproval(rejectionMatch[1]));
    const stopMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
    if (request.method === 'POST' && stopMatch?.[1]) { orchestrator.stopTask(stopMatch[1]); return json(response, 200, { ok: true }); }
    if (request.method === 'GET' && url.pathname === '/api/memory') {
      const projectId = url.searchParams.get('projectId') || undefined;
      const query = url.searchParams.get('query') || '';
      return json(response, 200, query ? memory.search(query, projectId) : memory.list(projectId));
    }
    if (request.method === 'POST' && url.pathname === '/api/memory') return json(response, 201, memory.write(await body(request) as Parameters<MemoryService['write']>[0]));
    const memoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
    if (request.method === 'DELETE' && memoryMatch?.[1]) { memory.remove(memoryMatch[1]); return json(response, 200, { ok: true }); }
    return json(response, 404, { error: '接口不存在' });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`LOOM_RUNTIME_URL=http://127.0.0.1:${port}\nLOOM_RUNTIME_TOKEN=${token}\n`);
  void orchestrator.refreshGateway();
});

const shutdown = () => {
  for (const client of clients) client.end();
  server.close(() => { store.close(); process.exit(0); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
