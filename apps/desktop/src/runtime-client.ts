import type { ModelRef, RoleBinding, RuntimeEvent, RuntimeSnapshot, TaskMode } from '@loom/shared';

let baseUrl = import.meta.env.VITE_LOOM_RUNTIME_URL || 'http://127.0.0.1:3210';
let token = import.meta.env.VITE_LOOM_RUNTIME_TOKEN || 'loom-development';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init?.headers },
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

export const runtime = {
  configure(config: { runtimeUrl: string; token: string }) {
    baseUrl = config.runtimeUrl;
    token = config.token;
  },
  snapshot: () => request<RuntimeSnapshot>('/api/snapshot'),
  refreshGateway: () => request('/api/gateway/refresh', { method: 'POST' }),
  createProject: (title: string, path: string) => request('/api/projects', { method: 'POST', body: JSON.stringify({ title, path }) }),
  createTask: (projectId: string | undefined, prompt: string, mode: TaskMode) => request('/api/tasks', { method: 'POST', body: JSON.stringify({ projectId, prompt, mode }) }),
  approvePlan: (id: string) => request(`/api/plans/${id}/approve`, { method: 'POST' }),
  approveCommand: (id: string) => request(`/api/approvals/${id}/approve-command`, { method: 'POST' }),
  approveDangerous: (id: string) => request(`/api/approvals/${id}/approve-dangerous`, { method: 'POST' }),
  rejectApproval: (id: string) => request(`/api/approvals/${id}/reject`, { method: 'POST' }),
  stopTask: (id: string) => request(`/api/tasks/${id}/stop`, { method: 'POST' }),
  bindRole: (binding: RoleBinding) => request('/api/bindings', { method: 'POST', body: JSON.stringify(binding) }),
  addModel: (model: ModelRef) => request('/api/models', { method: 'POST', body: JSON.stringify(model) }),
  loadCredential: (reference: string, secret: string) => request('/api/credentials', { method: 'POST', body: JSON.stringify({ reference, secret }) }),
  listMemory: (projectId?: string) => request<Array<{ id: string; projectId?: string; name: string; content: string; revision: string }>>(`/api/memory${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  saveMemory: (value: { id?: string; projectId?: string; name: string; content: string; expectedRevision?: string }) => request('/api/memory', { method: 'POST', body: JSON.stringify(value) }),
  removeMemory: (id: string) => request(`/api/memory/${id}`, { method: 'DELETE' }),
  events(onEvent: (event: RuntimeEvent) => void): () => void {
    const source = new EventSource(`${baseUrl}/api/events?token=${encodeURIComponent(token)}`);
    const handler = (event: MessageEvent<string>) => onEvent(JSON.parse(event.data) as RuntimeEvent);
    const names = ['task.created', 'message.created', 'message.delta', 'plan.created', 'plan.approved', 'approval.created', 'approval.approved', 'approval.rejected', 'agent.started', 'file.written', 'worktree.created', 'task.completed', 'task.failed', 'task.cancelled', 'gateway.changed', 'bindings.changed', 'models.changed', 'project.created'];
    for (const name of names) source.addEventListener(name, handler as EventListener);
    return () => source.close();
  },
};
