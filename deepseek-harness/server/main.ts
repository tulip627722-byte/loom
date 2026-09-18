import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Harness } from './harness.ts';
import { Loom } from './service.ts';
import { safePath } from './files.ts';
import { preparePresets } from './presets.ts';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.LOOM_PORT||3080);
const previewPort=Number(process.env.LOOM_PREVIEW_PORT||port+2);
const dataRoot=resolve(process.env.LOOM_DATA_DIR||join(homedir(),'LoomData'));
const dshHome=resolve(process.env.DSH_HOME||join(homedir(),'.dsh'));
const upstream=process.env.LOOM_HARNESS_URL||'http://127.0.0.1:3081';
const bridgeToken=process.env.LOOM_BRIDGE_TOKEN||randomUUID();
preparePresets(repoRoot,dshHome,dataRoot);
const harness=new Harness(upstream);const app=new Loom(dataRoot,dshHome,harness);
const staticRoot=resolve(repoRoot,'../deepseek-harness-ui/dist/client');
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'};
const json=(res:ServerResponse,value:any,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function body(req:IncomingMessage) {
  let content='';for await(const chunk of req){content+=chunk;if(Buffer.byteLength(content)>12_000_000)throw Error('请求内容过大');}
  return content?JSON.parse(content):{};
}
function validOrigin(req:IncomingMessage) {
  const host=req.headers.host||'';
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return false;
  if(req.headers.origin&&!([`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin)))return false;
  return req.headers['sec-fetch-site']!=='cross-site';
}
const proxyMethods=new Set(['host.describe','host.pickDirectory','host.listDirectory','host.openPath','workspace.list','workspace.create','workspace.rename','session.list','session.search','session.create','session.history','session.models','session.selectModel','session.rename','session.prompt','session.cancel','subagent.list','subagent.history','subagent.prompt','subagent.interrupt','skill.list','agentPreset.list','llm.providers','llm.models','llm.discoverModels','settings.describe','settings.mutate','credentials.describe','credentials.set','credentials.unset']);

const server=createServer(async(req,res)=>{
  try {
    if(!validOrigin(req))return json(res,{error:'仅允许本地工作台访问'},403);
    const url=new URL(req.url||'/',`http://127.0.0.1:${port}`);const path=url.pathname;
    if(path==='/internal/work') {
      if(req.method!=='POST'||req.headers.authorization!==`Bearer ${bridgeToken}`)return json(res,{error:'未授权'},403);
      const b=await body(req);return json(res,app.work(b.operation,b.args,b.sessionId,b.cwd,b.author));
    }
    if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers['x-loom-client']!=='workbench')return json(res,{error:'缺少工作台请求标识'},403);
    if(path==='/loom/events') {
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      const send=(e:any)=>res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      let cursor=Number(req.headers['last-event-id']||url.searchParams.get('after')||app.store.latestEventSequence());
      // Register first. Synchronous replay and DB inserts preserve ordering.
      app.listeners.add(send);
      for(let batch=app.store.events(cursor);batch.length;batch=app.store.events(cursor)) {
        for(const e of batch)send({...e,replay:true});cursor=batch.at(-1)!.seq;
      }
      res.write(`event: ready\ndata: ${JSON.stringify({pending:[...harness.pending.values()],connected:harness.connected})}\n\n`);
      const keep=setInterval(()=>res.write(': ping\n\n'),15000);req.on('close',()=>{clearInterval(keep);app.listeners.delete(send);});return;
    }
    if(path.startsWith('/api/')) {
      if(req.method!=='POST')return json(res,{error:'仅支持 POST'},405);
      const b=await body(req);const method=path.slice(5);
      if(!proxyMethods.has(method)||b.method!==method||b.type!=='client-request')return json(res,{error:'不支持的 Harness 请求'},400);
      try {
        let value;
        if(method==='session.prompt') {
          const text=(b.payload.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('');
          const run=await app.submit(b.payload.sessionId,text);value={accepted:true,runId:run.id};void app.dispatch();
        } else if(method==='session.cancel')value=await app.cancel(b.payload.sessionId);
        else if(method==='session.create') {
          const project=app.store.list('projects').find(p=>p.path===b.payload.cwd||p.workspaceId===b.payload.workspaceId);
          const task=await app.createTask({projectId:project?.id,title:'新任务'});value={sessionId:task.sessionId,agentPreset:'loom-work'};
        } else {value=await harness.rpc(method,b.payload);if(method==='workspace.create')await app.syncProjects();if(method==='session.selectModel')app.recordTaskModel(b.payload.sessionId,b.payload);}
        return json(res,{type:'server-response',rpcId:b.rpcId,result:{ok:true,value}});
      } catch(e) {return json(res,{type:'server-response',rpcId:b.rpcId,result:{ok:false,error:{code:'loom-error',message:(e as Error).message}}});}
    }
    if(path==='/loom/state')return json(res,{...app.snapshot(),pending:[...harness.pending.values()],connected:harness.connected,dataRoot,platform:process.platform,previewOrigin:`http://127.0.0.1:${previewPort}`});
    if(path==='/loom/tasks'&&req.method==='POST')return json(res,await app.createTask(await body(req)));
    if(path==='/loom/tasks/archive'&&req.method==='POST'){const b=await body(req);return json(res,await app.setTaskArchived(b.sessionId,!!b.archived));}
    if(path==='/loom/discussions/confirm'&&req.method==='POST'){const b=await body(req);return json(res,await app.confirmDiscussion(b.id));}
    if(path==='/loom/previews'&&req.method==='POST'){const b=await body(req);return json(res,app.work('preview',b.args||b,b.sessionId));}
    if(path==='/loom/submit'&&req.method==='POST') {const b=await body(req);const run=await app.submit(b.sessionId,b.text,'user',b.planId);void app.dispatch();return json(res,run);}
    if(path==='/loom/respond'&&req.method==='POST'){const b=await body(req);return json(res,await harness.respond(b.rpcId,b.value));}
    if(path==='/loom/work'&&req.method==='POST'){const b=await body(req);return json(res,app.work(b.operation,b.args,b.sessionId));}
    if(path==='/loom/memory'&&req.method==='GET') {const name=url.searchParams.get('name');return json(res,name?app.memory.read(name):app.memory.list());}
    if(path==='/loom/memory'&&req.method==='POST'){const b=await body(req);const r=app.memory.write(b.name,b.content,b.revision);app.emit({type:'memory',name:b.name});return json(res,r);}
    if(path==='/loom/skills') {
      const saved=app.skills();const sessionId=url.searchParams.get('sessionId');let catalog:any[]=[];let error='';
      if(sessionId)try{catalog=(await harness.rpc('skill.list',{sessionId})).skills;}catch(e){error=String(e);}
      const map=new Map(saved.map(s=>[s.name,s]));for(const s of catalog)map.set(s.name,{...map.get(s.name),...s,status:'loadable',category:map.get(s.name)?.category||'development'});
      return json(res,{items:[...map.values()],catalogError:error});
    }
    if(path==='/loom/drafts/confirm'&&req.method==='POST'){const b=await body(req);return json(res,app.approveDraft(b.id,b.revision,b.content));}
    if(path==='/loom/drafts/cancel'&&req.method==='POST'){const b=await body(req);const d=app.store.get('drafts',b.id);if(!d||d.status!=='draft')throw Error('草稿已处理');const r=app.store.put('drafts',{id:b.id,status:'cancelled'});app.emit({type:'draft',draft:r});return json(res,r);}
    if(path==='/loom/todos/migrate'&&req.method==='POST') {
      const b=await body(req);if(!Array.isArray(b.items))throw Error('待办格式无效');
      if(!app.store.get('settings','legacy-todos'))app.store.transaction(()=>{for(const t of b.items){if(/^task-[123]$/.test(t.id))continue;if(typeof t.text==='string'&&t.text.trim())app.work('todo',{text:t.text,done:!!t.done});}app.store.put('settings',{id:'legacy-todos',migrated:true});});
      return json(res,{ok:true});
    }
    if(path==='/loom/notification/read'&&req.method==='POST'){const b=await body(req);if(!app.store.get('notifications',b.id))throw Error('通知不存在');return json(res,app.store.put('notifications',{id:b.id,read:true}));}
    if(path==='/loom/schedule/toggle'&&req.method==='POST'){const b=await body(req);const s=app.store.get('schedules',b.id);if(!s)throw Error('安排不存在');return json(res,app.store.put('schedules',{id:b.id,enabled:!!b.enabled}));}
    if(path==='/loom/schedule/run'&&req.method==='POST') {const b=await body(req);const s=app.store.get('schedules',b.id);if(!s||s.kind!=='task')throw Error('执行安排不存在');const t=await app.createTask({projectId:s.projectId,title:s.title});const r=await app.submit(t.sessionId,s.prompt,'manual-schedule');void app.dispatch();return json(res,r);}
    if(path==='/loom/projects/rebind'&&req.method==='POST') {const b=await body(req);const project=app.project(b.id)!;if(typeof b.path!=='string'||!existsSync(b.path)||!statSync(b.path).isDirectory())throw Error('请选择存在的文件夹');const ws=await harness.rpc('workspace.create',{path:resolve(b.path)});const p=app.store.put('projects',{id:project.id,path:resolve(b.path),workspaceId:ws.workspace?.workspaceId||ws.workspaceId});app.emit({type:'changed'});return json(res,p);}
    if(path==='/loom/export') {res.setHeader('content-disposition','attachment; filename="loom-migration.json"');return json(res,app.exportData());}
    if(path==='/loom/import'&&req.method==='POST')return json(res,app.importData(await body(req)));
    if(path==='/loom/artifact'&&req.method==='GET') {
      return json(res,app.readArtifact(url.searchParams.get('id')||''));
    }
    if(path==='/loom/artifact/save'&&req.method==='POST'){const b=await body(req);return json(res,app.saveArtifact(b.id,b.content,b.revision));}
    if(path.startsWith('/loom/'))return json(res,{error:'接口不存在'},404);
    if(req.method!=='GET'&&req.method!=='HEAD')return json(res,{error:'不支持的请求'},405);
    const name=decodeURIComponent(path).replace(/^\/+/, '')||'index.html';
    let file=safePath(staticRoot,name);if(!existsSync(file)||!statSync(file).isFile()) {
      if(extname(name))return json(res,{error:'文件不存在'},404);file=join(staticRoot,'index.html');
    }
    res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
  }catch(e){if(!res.headersSent)json(res,{error:(e as Error).message},400);else res.end();}
});

const previewServer=createServer((req,res)=>{
  try {
    const host=req.headers.host||'';if(![`127.0.0.1:${previewPort}`,`localhost:${previewPort}`].includes(host))return json(res,{error:'仅允许本地预览'},403);
    if(req.method!=='GET'&&req.method!=='HEAD')return json(res,{error:'预览只支持读取'},405);
    const url=new URL(req.url||'/',`http://127.0.0.1:${previewPort}`),match=url.pathname.match(/^\/preview\/([^/]+)(?:\/(.*))?$/);if(!match)return json(res,{error:'预览不存在'},404);
    const preview=app.store.get('previews',decodeURIComponent(match[1]));if(!preview||preview.sourceType!=='static-html'||preview.status!=='ready')return json(res,{error:'预览不存在或不可用'},404);
    const project=app.project(preview.projectId);if(project&&!project.path)throw Error('项目还未重新绑定');
    const projectRoot=project?.path||join(dataRoot,'artifacts'),entry=safePath(projectRoot,preview.entryPath),root=dirname(entry);
    const requested=decodeURIComponent(match[2]||'');let file=requested?safePath(root,requested):entry;
    if(!existsSync(file)||!statSync(file).isFile())return json(res,{error:'预览资源不存在'},404);
    const headers:Record<string,string>={'content-type':mime[extname(file).toLowerCase()]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'cross-origin'};
    if(/\.html?$/i.test(file))headers['content-security-policy']=`frame-ancestors http://127.0.0.1:${port} http://localhost:${port}`;
    res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:readFileSync(file));
  } catch(error) {if(!res.headersSent)json(res,{error:(error as Error).message},400);else res.end();}
});

for(const run of app.store.list('runs').filter(r=>r.status==='preparing'))app.store.put('runs',{id:run.id,status:'interrupted',error:'准备过程中服务重启，未自动重试'});
server.listen(port,'127.0.0.1',()=>console.log(`Loom: http://127.0.0.1:${port} · data: ${dataRoot}`));
previewServer.listen(previewPort,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${previewPort}`));
void harness.consume(frame=>app.onFrame(frame));
void app.syncProjects().catch(e=>console.error('项目同步暂不可用:',e.message));
const timer=setInterval(()=>void app.tick().catch(e=>console.error('调度:',e.message)),1000);
const reconcile=setInterval(()=>void app.reconcile().catch(()=>{}),5000);
const projects=setInterval(()=>void app.syncProjects().catch(()=>{}),10000);
async function shutdown(){app.stopping=true;clearInterval(timer);clearInterval(reconcile);clearInterval(projects);harness.stop();for(const listener of app.listeners)listener({type:'shutdown'});server.close();server.closeAllConnections();previewServer.close();previewServer.closeAllConnections();setTimeout(()=>{app.store.close();process.exit(0);},250).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
