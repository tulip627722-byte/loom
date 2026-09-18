import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Loom,nextOccurrence } from '../server/service.ts';
import { Harness,endStatus } from '../server/harness.ts';
import { safePath,revision } from '../server/files.ts';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'loom-test-'));
  const h=new Harness('http://127.0.0.1:1');
  const calls:any[]=[];let i=0;
  h.rpc=async(method,payload={})=>{calls.push({method,payload});if(method==='session.models')return {current:{provider:'deepseek',model:'deepseek-v4-flash'}};if(method==='session.create')return {sessionId:`session-${++i}`};if(method==='session.history')return {events:[]};if(method==='session.list')return {items:[]};return {accepted:true};};
  const app=new Loom(root,join(root,'dsh'),h);return {root,app,h,calls};
}
test('draft cannot install until confirmation; revision conflicts and duplicate saves fail',()=>{
  const {app,root}=fixture();
  const content='---\nname: test-prd\ndescription: Test product requirements\nmetadata:\n  category: product\n---\nAsk for goal and constraints.';
  const draft=app.work('draft',{content},'s',undefined,true);
  assert.equal(existsSync(join(root,'skills/test-prd/SKILL.md')),false);
  assert.throws(()=>app.work('todo',{text:'forbidden'},'s',undefined,true));
  assert.throws(()=>app.approveDraft(draft.id,'stale',content));
  app.approveDraft(draft.id,draft.revision,content);
  assert.equal(readFileSync(join(root,'skills/test-prd/SKILL.md'),'utf8'),content);
  assert.throws(()=>app.approveDraft(draft.id,draft.revision,content));app.store.close();
});
test('memory updates are fresh, optimistic concurrency prevents clobber, project contexts are isolated',()=>{
  const {app}=fixture();
  const a=app.store.put('projects',{title:'A'}),b=app.store.put('projects',{title:'B'});
  app.store.put('tasks',{sessionId:'a',projectId:a.id});app.store.put('tasks',{sessionId:'b',projectId:b.id});
  const name=`projects/${a.id}/overview.md`;app.memory.write(name,'Project A secret',revision(''));
  assert.match(JSON.stringify(app.context('a')),/Project A secret/);
  assert.doesNotMatch(JSON.stringify(app.context('b')),/Project A secret/);
  assert.throws(()=>app.memory.write(name,'bad',revision('')));
  app.memory.write(name,'Corrected',app.memory.read(name).revision);
  assert.match(JSON.stringify(app.context('a')),/Corrected/);app.store.close();
});
test('memory context stays small and retrieves only relevant project notes',()=>{
  const {app}=fixture();const project=app.store.put('projects',{title:'A'});app.store.put('tasks',{sessionId:'a',projectId:project.id});
  app.memory.write('MEMORY.md','x'.repeat(5000),revision(''));
  app.memory.write(`projects/${project.id}/decisions.md`,'# UI\nKeep the blue pixel style.\n\n# Billing\nUse annual invoices.',revision(''));
  const context=app.context('a',undefined,'How should the blue UI look?');const serialized=JSON.stringify(context.files);
  assert.ok(serialized.length<1800);assert.match(serialized,/blue pixel/);assert.doesNotMatch(serialized,/annual invoices/);app.store.close();
});
test('failed, blocked, interrupted and stopped turns are never completed',()=>{
  assert.equal(endStatus({kind:'completed'}),'completed');
  for(const kind of ['error','blocked','max-tokens','unknown'])assert.equal(endStatus({kind}),'failed');
  assert.equal(endStatus({kind:'aborted'}),'stopped');assert.equal(endStatus({kind:'interrupted'}),'interrupted');
});
test('schedule trigger survives restart and is claimed only once',async()=>{
  const {app,root,h}=fixture();const now=Date.now();
  app.work('schedule',{title:'remind',kind:'reminder',nextAt:new Date(now-1000).toISOString(),timezone:'Asia/Shanghai',recurrence:'once'});
  await app.tick(now);assert.equal(app.store.list('notifications').length,1);app.store.close();
  const again=new Loom(root,join(root,'dsh'),h);await again.tick(now+3000);assert.equal(again.store.list('notifications').length,1);again.store.close();
});
test('overdue task does not execute on wake, recurrent next occurrence advances',async()=>{
  const {app,calls}=fixture();const now=Date.now();
  app.work('schedule',{title:'daily',kind:'task',prompt:'do it',nextAt:new Date(now-86400000).toISOString(),timezone:'Asia/Shanghai',recurrence:'daily'});
  await app.tick(now);assert.equal(calls.filter(c=>c.method==='session.prompt').length,0);
  assert.ok(Date.parse(app.store.list('schedules')[0].nextAt)>now);assert.equal(app.store.list('notifications')[0].missed,true);app.store.close();
});
test('daily schedule retains wall time through DST',()=>{
  assert.equal(nextOccurrence('2026-03-07T14:00:00.000Z','daily','America/New_York',Date.parse('2026-03-07T14:00:01Z')),'2026-03-08T13:00:00.000Z');
});
test('same project serializes tasks and native completion releases the queue',async()=>{
  const {app,calls,root}=fixture();const p=app.store.put('projects',{title:'A',path:root});
  const a=await app.createTask({projectId:p.id}),b=await app.createTask({projectId:p.id});
  const first=await app.submit(a.sessionId,'first');await app.submit(b.sessionId,'second');await app.dispatch();
  assert.equal(calls.filter(c=>c.method==='session.prompt').length,1);
  app.onFrame({rpcId:'e',payload:{type:'session/event',sessionId:a.sessionId,event:{type:'turn/end',seq:3,data:{reason:{kind:'completed'}}}}});
  assert.equal(app.store.get('runs',first.id)?.status,'settling');await app.dispatch();assert.equal(calls.filter(c=>c.method==='session.prompt').length,1);
  app.finish(app.store.get('runs',first.id)!,{type:'turn/end',seq:3,data:{reason:{kind:'completed'}}});
  await app.dispatch();assert.equal(calls.filter(c=>c.method==='session.prompt').length,2);app.store.close();
});
test('portable export excludes credentials and paths; import retains memory and pauses schedules',()=>{
  const {app,root}=fixture();const p=app.store.put('projects',{title:'A',path:'/Users/private/project',workspaceId:'old'});
  app.store.put('settings',{id:'secret',apiKey:'never-export'});
  app.memory.write(`projects/${p.id}/overview.md`,'portable',revision(''));
  app.work('schedule',{title:'remember',kind:'reminder',nextAt:new Date().toISOString(),timezone:'Asia/Shanghai',recurrence:'daily',projectId:p.id});
  const data=app.exportData();assert.doesNotMatch(JSON.stringify(data),/never-export|\/Users\/private/);
  const dest=new Loom(join(root,'dest'),join(root,'dsh'),new Harness('http://127.0.0.1:1'));
  const imported=dest.importData(data);assert.equal(dest.store.list('projects')[0].path,null);assert.equal(dest.store.list('schedules')[0].enabled,false);
  assert.equal(dest.memory.read(`projects/${imported.projectIds[0]}/overview.md`).content,'portable');dest.store.close();app.store.close();
});
test('path traversal and Windows drive paths cannot escape data root',()=>{
  const {root,app}=fixture();for(const name of ['../settings.yaml','C:\\secret','C:/secret','/etc/passwd','a/../../b'])assert.throws(()=>safePath(root,name));app.store.close();
});
test('cancel queued runs does not mark an active run as completed',async()=>{
  const {app}=fixture();const t=await app.createTask({});const r=await app.submit(t.sessionId,'hello');await app.cancel(t.sessionId);assert.equal(app.store.get('runs',r.id)?.status,'stopped');app.store.close();
});
test('archive hides only the task reference and restore preserves its project and artifacts',async()=>{
  const {app,root}=fixture();const project=app.store.put('projects',{title:'A',path:root});
  const task=await app.createTask({projectId:project.id,title:'Keep me'});const artifact=app.store.put('artifacts',{taskId:task.id,projectId:project.id,title:'Result',path:'result.txt'});
  const archived=await app.setTaskArchived(task.sessionId,true);
  assert.ok(archived.archivedAt);assert.equal(archived.projectId,project.id);assert.equal(app.store.get('artifacts',artifact.id)?.taskId,task.id);
  const restored=await app.setTaskArchived(task.sessionId,false);
  assert.equal(restored.archivedAt,null);assert.equal(restored.projectId,project.id);assert.equal(app.store.get('artifacts',artifact.id)?.title,'Result');app.store.close();
});
test('running tasks cannot be archived',async()=>{
  const {app}=fixture();const task=await app.createTask({});await app.submit(task.sessionId,'hello');
  await assert.rejects(()=>app.setTaskArchived(task.sessionId,true),/先停止再归档/);app.store.close();
});
test('replayed interrupted turn emits exactly one notification',async()=>{
  const {app}=fixture();const t=await app.createTask({});const r=await app.submit(t.sessionId,'hello');await app.dispatch();
  const event={type:'turn/end',seq:3,data:{reason:{kind:'interrupted'}}};
  app.finish(app.store.get('runs',r.id)!,event);app.finish(app.store.get('runs',r.id)!,event);
  assert.equal(app.store.list('notifications').length,1);app.store.close();
});
test('portable artifacts open after import and malformed packages do not change business records',()=>{
  const {app,root}=fixture();writeFileSync(join(root,'artifacts/result.txt'),'verified');app.work('artifact',{path:'result.txt'});
  const data=app.exportData();const dest=new Loom(join(root,'dest'),join(root,'dsh'),new Harness('http://127.0.0.1:1'));
  dest.importData(data);const artifact=dest.store.list('artifacts')[0];assert.equal(readFileSync(join(dest.root,'artifacts',artifact.path),'utf8'),'verified');
  const bad={...data,projects:[{id:'p',title:'bad'}],files:{'memory/not-markdown.txt':'bad'}};
  assert.throws(()=>dest.importData(bad));assert.equal(dest.store.list('projects').length,0);dest.store.close();app.store.close();
});
test('background delegation does not complete the parent before all children settle',async()=>{
  const {app,h}=fixture();const t=await app.createTask({kind:'work'});const run=await app.submit(t.sessionId,'review');await app.dispatch();
  let childRunning=true;
  h.rpc=async(method)=>method==='session.list'?{items:[{sessionId:t.sessionId,running:false}]}:method==='subagent.list'?{entries:[{activity:childRunning?'running':'inactive'}]}:{events:[{event:{type:'turn/start',seq:1}},{event:{type:'turn/end',seq:2,time:Date.now()-10000,data:{reason:{kind:'completed'}}}}]};
  await app.reconcile();assert.notEqual(app.store.get('runs',run.id)?.status,'completed');
  childRunning=false;await app.reconcile();assert.equal(app.store.get('runs',run.id)?.status,'completed');assert.equal(app.store.list('notifications').length,1);app.store.close();
});
test('review agents must hand off one shared document in order before confirmation',async()=>{
  const {app,root,calls}=fixture();const project=app.store.put('projects',{title:'A',path:root});const task=await app.createTask({kind:'review',projectId:project.id});
  assert.equal(calls.find(c=>c.method==='session.selectModel')?.payload.reasoningEffort,'low');
  const run=await app.submit(task.sessionId,'Design a small feature');const id=run.discussionId;let doc=app.work('discussion',{action:'get',id},task.sessionId);
  assert.equal(doc.stage,'brief');assert.throws(()=>app.work('discussion',{action:'update',id,section:'engineering-review',content:'too early',revision:doc.revision},task.sessionId));
  assert.throws(()=>app.work('discussion',{action:'update',id,section:'innovation',content:'x'.repeat(1201),revision:doc.revision},task.sessionId),/1200/);
  for(const [section,content] of [['innovation','idea'],['engineering-review','review'],['innovation-revision','revision'],['engineering-delivery','delivery'],['final','summary']])doc=app.work('discussion',{action:'update',id,section,content,revision:doc.revision},task.sessionId);
  assert.equal(doc.status,'pending-confirmation');const confirmed=await app.confirmDiscussion(id);
  assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.plan.status,'decided');assert.match(confirmed.content,/delivery/);
  assert.equal(confirmed.tasks.length,2);assert.equal(app.store.list('workItems').length,2);assert.ok(confirmed.tasks.every((child:any)=>child.parentTaskId===task.id));app.store.close();
});
test('confirmed execution sessions receive a compact handoff, not the whole debate',async()=>{
  const {app,root}=fixture();const project=app.store.put('projects',{title:'A',path:root});const task=await app.createTask({kind:'review',projectId:project.id});
  const run=await app.submit(task.sessionId,'Build a compact workbench');const id=run.discussionId;let doc=app.work('discussion',{action:'get',id},task.sessionId);
  for(const [section,content] of [['innovation','INNOVATION_SECRET '.repeat(30)],['engineering-review','REVIEW_SECRET '.repeat(30)],['innovation-revision','REVISION_SECRET '.repeat(30)],['engineering-delivery','Ship the smallest verified slice.'],['final','Use the confirmed local-first direction.']])doc=app.work('discussion',{action:'update',id,section,content,revision:doc.revision},task.sessionId);
  await app.confirmDiscussion(id);const executionRuns=app.store.list('runs').filter(row=>row.source==='confirmed-plan');
  assert.ok(executionRuns.length>0);for(const child of executionRuns) {
    assert.equal(child.contextPolicy,'minimal-v1');assert.ok(child.planContent.length<=2100);
    assert.match(child.planContent,/confirmed local-first/);assert.doesNotMatch(child.planContent,/INNOVATION_SECRET|REVIEW_SECRET|REVISION_SECRET/);
  }
  assert.match(app.store.list('plans')[0].content,/INNOVATION_SECRET/);app.store.close();
});
test('preview registration validates local HTML and classifies URLs without reading credentials',()=>{
  const {app,root}=fixture();mkdirSync(join(root,'artifacts/site'),{recursive:true});writeFileSync(join(root,'artifacts/site/index.html'),'<link rel="stylesheet" href="style.css"><h1>ready</h1>');writeFileSync(join(root,'artifacts/site/style.css'),'h1{color:blue}');
  const localHtml=app.work('preview',{title:'Static result',path:'site/index.html'});assert.equal(localHtml.sourceType,'static-html');assert.equal(localHtml.status,'ready');assert.ok(localHtml.artifactId);
  const localUrl=app.work('preview',{url:'http://localhost:5173/demo'});assert.equal(localUrl.sourceType,'local-url');
  const external=app.work('preview',{url:'https://example.com/demo'});assert.equal(external.sourceType,'external-url');
  assert.throws(()=>app.work('preview',{path:'../outside.html'}));assert.throws(()=>app.work('preview',{url:'file:///tmp/index.html'}));app.store.close();
});
test('HTML and Markdown artifacts become previews automatically and text edits use revisions',()=>{
  const {app,root}=fixture();mkdirSync(join(root,'artifacts/docs'),{recursive:true});
  writeFileSync(join(root,'artifacts/docs/index.html'),'<h1>HTML preview</h1>');
  writeFileSync(join(root,'artifacts/docs/map.md'),'# Map\n\n```mermaid\nmindmap\n  root((Loom))\n    Build\n```\n');
  const html=app.work('artifact',{title:'Page',path:'docs/index.html'});const markdown=app.work('artifact',{title:'Mind map',path:'docs/map.md'});
  assert.equal(html.preview.sourceType,'static-html');assert.equal(markdown.preview.sourceType,'markdown');assert.equal(app.store.list('previews').length,2);
  const opened=app.readArtifact(markdown.id);assert.match(opened.content,/mindmap/);
  const saved=app.saveArtifact(markdown.id,opened.content.replace('Build','Ship'),opened.revision);assert.match(saved.content,/Ship/);
  assert.throws(()=>app.saveArtifact(markdown.id,'stale',opened.revision),/重新加载/);app.store.close();
});
test('slash plan uses mounted command remote instead of becoming plain model text',async()=>{
  const {app,h,calls}=fixture();const original=h.rpc.bind(h);
  h.rpc=async(method,payload)=>{if(method==='commands/execute'){calls.push({method,payload});return {result:{kind:'success',text:'Plan mode on'}};}return original(method,payload);};
  const t=await app.createTask({});await app.submit(t.sessionId,'/plan inspect the project');await app.dispatch();
  assert.equal(calls.filter(c=>c.method==='session.prompt').length,0);
  assert.match(calls.find(c=>c.method==='commands/execute').payload.args.line,/^\/plan /);app.store.close();
});
