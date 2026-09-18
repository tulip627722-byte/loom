import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Row, type Kind } from './store.ts';
import { MemoryFiles, safePath, listSkills, validateSkill, revision, walk } from './files.ts';
import { Harness, endStatus, type Frame } from './harness.ts';

const terminal = new Set(['completed','failed','stopped','interrupted']);
const discussionNext: Record<string,string>={innovation:'brief','engineering-review':'innovation','innovation-revision':'engineering-review','engineering-delivery':'innovation-revision',final:'engineering-delivery'};
const workTerminal = new Set(['completed','failed','stopped','interrupted','blocked']);
function compact(content: string,max: number) {return content.trim().slice(0,max);}
function relevant(content: string,query: string,max=900) {
  if(!content.trim()||!query.trim())return '';
  const terms=[...new Set((query.toLowerCase().match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu)||[]).flatMap(term=>/[\p{Script=Han}]/u.test(term)&&term.length>3?[term,...Array.from({length:term.length-1},(_,i)=>term.slice(i,i+2))]:[term]))];
  if(!terms.length)return '';
  const chunks=content.split(/\n(?=#{1,6}\s)|\n\s*\n/).map((text,index)=>({text:text.trim(),index})).filter(x=>x.text);
  return chunks.map(chunk=>({...chunk,score:terms.reduce((score,term)=>score+(chunk.text.toLowerCase().includes(term)?1:0),0)}))
    .filter(chunk=>chunk.score>0).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,2).sort((a,b)=>a.index-b.index)
    .map(chunk=>chunk.text).join('\n\n').slice(0,max);
}
function renderDiscussion(row: Row) {
  const s=row.sections||{};
  return `# ${row.title}\n\n## 目标与约束\n${row.brief}\n\n## 创新方案\n${s.innovation||'（等待创新 Agent）'}\n\n## 工程评审\n${s['engineering-review']||'（等待工程 Agent）'}\n\n## 修订方案\n${s['innovation-revision']||'（等待创新 Agent 修订）'}\n\n## 落地计划\n${s['engineering-delivery']||'（等待工程 Agent 收尾）'}\n\n## Loom 汇总\n${s.final||'（等待汇总）'}`;
}
function executionBrief(row: Row) {
  const final=compact(row.sections?.final||'',700);
  const delivery=compact(row.sections?.['engineering-delivery']||'',700);
  return [
    '# 已确认方案摘要',
    `## 目标与约束\n${compact(row.brief||'',550)}`,
    final&&`## 用户确认时的结论\n${final}`,
    delivery&&`## 工程交接\n${delivery}`,
  ].filter(Boolean).join('\n\n').slice(0,2100);
}
function filePreviewType(path: string) {
  if(/\.html?$/i.test(path))return 'static-html';
  if(/\.(md|markdown)$/i.test(path))return 'markdown';
  return undefined;
}
type WorkItemDraft={title:string;objective:string;mode:'read'|'write';dependsOn:number[];deliverables:string[];preview:boolean};
function normalizeWorkItems(input: unknown, fallback: string): WorkItemDraft[] {
  const raw=Array.isArray(input)?input.slice(0,4):[];
  const items:WorkItemDraft[]=raw.map((item:any,index):WorkItemDraft=>{
    if(!item||typeof item!=='object')throw Error(`执行项 ${index+1} 格式无效`);
    const title=String(item.title||'').trim().slice(0,100),objective=String(item.objective||'').trim().slice(0,1800);
    if(!title||!objective)throw Error(`执行项 ${index+1} 缺少标题或目标`);
    const dependsOn=[...new Set<number>((Array.isArray(item.dependsOn)?item.dependsOn:[]).map((value:any)=>Number(value)).filter((n:number)=>Number.isInteger(n)&&n>=0&&n<index))];
    const deliverables:string[]=(Array.isArray(item.deliverables)?item.deliverables:[]).map((x:any)=>String(x).trim()).filter(Boolean).slice(0,6);
    return {title,objective,mode:item.mode==='read'?'read':'write',dependsOn,deliverables,preview:!!item.preview};
  });
  if(items.length)return items;
  return [
    {title:'实现已确认方案',objective:`根据已确认方案完成实现：${compact(fallback,900)}`,mode:'write',dependsOn:[],deliverables:['可验证的实现产出'],preview:/界面|页面|网站|html|前端|preview/i.test(fallback)},
    {title:'验证与交付检查',objective:'检查实现结果、运行相关测试，并记录仍需人工确认的风险。',mode:'read',dependsOn:[0],deliverables:['验证结果与遗留风险'],preview:false},
  ];
}
export function nextOccurrence(previous: string, recurrence: string, timezone: string, now: number) {
  if (recurrence === 'once') return null;
  // Retain local wall clock across DST: advance calendar days, then solve the
  // requested zone's offset using Intl (available on both supported platforms).
  const fmt = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=(time:number)=>Object.fromEntries(fmt.formatToParts(time).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  let cursor=Date.parse(previous);
  for(let i=0;i<40000;i++) {
    const p=parts(cursor); const target=Date.UTC(p.year,p.month-1,p.day+(recurrence==='weekly'?7:1),p.hour,p.minute,p.second);
    let guess=target;
    for(let j=0;j<4;j++) {const q=parts(guess); const actual=Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute,q.second); const delta=target-actual; if(!delta) break; guess+=delta;}
    cursor=guess;
    if(cursor>now) return new Date(cursor).toISOString();
  }
  throw new Error('无法计算下一次运行时间');
}

export class Loom {
  store: Store; memory: MemoryFiles; harness: Harness; root: string; dshHome: string;
  listeners = new Set<(event:any)=>void>();
  busy = false; ticking = false; stopping = false;
  sessionLocks = new Set<string>();
  constructor(root: string, dshHome: string, harness: Harness) {
    this.root=resolve(root);this.dshHome=dshHome;this.harness=harness;
    this.store=new Store(this.root);this.memory=new MemoryFiles(this.root);
    mkdirSync(join(this.root,'skills'),{recursive:true});mkdirSync(join(this.root,'artifacts'),{recursive:true});
    for(const artifact of this.store.list('artifacts'))if(filePreviewType(artifact.path)&&!this.store.list('previews').some(preview=>preview.artifactId===artifact.id)) {
      try{this.readArtifact(artifact.id);this.registerArtifactPreview(artifact,artifact.taskId?this.store.get('tasks',artifact.taskId):undefined);}catch{/* unavailable imports stay unavailable until rebound */}
    }
  }
  emit(data: any) {const seq=this.store.event(data); for(const listener of this.listeners) listener({seq,...data});}
  snapshot() {return Object.fromEntries(['projects','tasks','runs','todos','schedules','notifications','plans','artifacts','drafts','discussions','workItems','previews'].map(k=>[k,this.store.list(k as Kind)]));}
  projectForSession(id: string) {return this.store.list('tasks').find(t=>t.sessionId===id)?.projectId;}
  async syncProjects() {
    const result=await this.harness.rpc('workspace.list');
    for(const ws of result.items) {
      const previous=this.store.list('projects').find(p=>p.workspaceId===ws.workspaceId || p.path===ws.path);
      this.store.put('projects',{id:previous?.id,workspaceId:ws.workspaceId,path:ws.path,title:ws.title});
    }
  }
  project(id?: string) {
    if(!id) return undefined;
    const project=this.store.get('projects',id); if(!project) throw Error('项目不存在'); return project;
  }
  artifactFile(artifact: Row) {
    const project=this.project(artifact.projectId);
    if(project&&!project.path)throw Error('项目还未重新绑定');
    return safePath(project?.path||join(this.root,'artifacts'),artifact.path);
  }
  readArtifact(id: string) {
    const artifact=this.store.get('artifacts',id);if(!artifact)throw Error('产出不存在');
    const file=this.artifactFile(artifact);if(!existsSync(file)||!statSync(file).isFile()||statSync(file).size>2_000_000)throw Error('文件不可读取或过大');
    const content=readFileSync(file,'utf8');return {...artifact,content,revision:revision(content)};
  }
  saveArtifact(id: string,content: unknown,expectedRevision: unknown) {
    const artifact=this.store.get('artifacts',id);if(!artifact)throw Error('产出不存在');
    if(!filePreviewType(artifact.path))throw Error('只能在工作台编辑 HTML 或 Markdown 产出');
    if(typeof content!=='string'||Buffer.byteLength(content)>2_000_000)throw Error('文件内容过大');
    const current=this.readArtifact(id);if(current.revision!==expectedRevision)throw Error('文件已被其他操作修改，请重新加载后合并');
    const file=this.artifactFile(artifact),temp=`${file}.${randomUUID()}.tmp`;writeFileSync(temp,content,'utf8');renameSync(temp,file);
    const saved=this.store.put('artifacts',{id:artifact.id,status:'exists'});
    const preview=this.store.list('previews').find(row=>row.artifactId===artifact.id);
    const updatedPreview=preview?this.store.put('previews',{id:preview.id,status:'ready'}):undefined;
    this.emit({type:'artifact-updated',artifact:saved,preview:updatedPreview});return {...saved,content,revision:revision(content)};
  }
  registerArtifactPreview(artifact: Row,task?: Row) {
    const sourceType=filePreviewType(artifact.path);if(!sourceType)return undefined;
    const previous=this.store.list('previews').find(row=>row.artifactId===artifact.id||(row.entryPath===artifact.path&&row.projectId===artifact.projectId&&row.sessionId===artifact.sessionId));
    const preview=this.store.put('previews',{id:previous?.id,projectId:artifact.projectId,taskId:task?.id||artifact.taskId,parentTaskId:task?.parentTaskId||artifact.parentTaskId,sessionId:artifact.sessionId,title:artifact.title||artifact.path,sourceType,entryPath:artifact.path,artifactId:artifact.id,status:'ready'});
    if(task?.workItemId)this.store.put('workItems',{id:task.workItemId,previewId:preview.id});
    this.emit({type:'preview',preview});return preview;
  }
  async ensureUsableModel(sessionId: string, preferred?: any) {
    let models=await this.harness.rpc('session.models',{sessionId});
    if(preferred?.provider&&preferred?.model) {
      await this.harness.rpc('session.selectModel',{sessionId,provider:preferred.provider,model:preferred.model,...(preferred.reasoningEffort?{reasoningEffort:preferred.reasoningEffort}:{})});
      models=await this.harness.rpc('session.models',{sessionId});
    }
    if(models.current?.provider&&models.current?.model)return models.current;
    const host=await this.harness.rpc('host.describe');
    const fallback=host.provider&&host.model?{provider:host.provider,model:host.model}:models.groups?.flatMap((g:any)=>g.models.map((m:any)=>({provider:g.id,model:m.id}))).at(0);
    if(!fallback)throw Error('尚未连接可用模型，请在“设置 → 模型与 API”完成配置');
    await this.harness.rpc('session.selectModel',{sessionId,...fallback});return fallback;
  }
  async createTask(input: any) {
    const project=this.project(input.projectId);
    if(project && (!project.path || !existsSync(project.path))) throw Error('请先绑定此电脑上的项目文件夹');
    const kind=['work','review','skill'].includes(input.kind)?input.kind:'work';
    const created=await this.harness.rpc('session.create',{cwd:project?.path || this.root,agentPreset:kind==='skill'?'loom-skill-author':'loom-work'});
    const selected=await this.ensureUsableModel(created.sessionId,input.modelSelection);
    const reasoningEffort=input.reasoningEffort||(kind==='review'?'low':selected.reasoningEffort);
    if(reasoningEffort&&reasoningEffort!==selected.reasoningEffort)await this.harness.rpc('session.selectModel',{sessionId:created.sessionId,provider:selected.provider,model:selected.model,reasoningEffort});
    const task=this.store.put('tasks',{sessionId:created.sessionId,projectId:project?.id,kind,title:String(input.title||'新任务').slice(0,160),parentTaskId:input.parentTaskId,workItemId:input.workItemId,role:input.role||'primary',provider:selected.provider,model:selected.model,reasoningEffort});
    await this.harness.rpc('session.rename',{sessionId:created.sessionId,title:task.title});
    this.emit({type:'task',task});return task;
  }
  recordTaskModel(sessionId: string, selection: any) {
    const task=this.store.list('tasks').find(t=>t.sessionId===sessionId);if(!task)return;
    const updated=this.store.put('tasks',{id:task.id,provider:selection.provider,model:selection.model,reasoningEffort:selection.reasoningEffort||null});
    this.emit({type:'task',task:updated});return updated;
  }
  async adopt(sessionId: string) {
    let task=this.store.list('tasks').find(t=>t.sessionId===sessionId);if(task)return task;
    const sessions=await this.harness.rpc('session.list');const session=sessions.items.find((s:any)=>s.sessionId===sessionId);
    if(!session)throw Error('会话不存在');
    const project=this.store.list('projects').find(p=>p.path===session.cwd);
    task=this.store.put('tasks',{sessionId,projectId:project?.id,title:session.projections?.values?.title||'历史会话',kind:'work',legacy:true});return task;
  }
  async setTaskArchived(sessionId: string, archived: boolean) {
    const task=await this.adopt(sessionId);
    if(archived) {
      const relatedSessions=new Set([sessionId,...this.store.list('tasks').filter(row=>row.parentTaskId===task.id).map(row=>row.sessionId)]);
      const active=this.store.list('runs').some(run=>relatedSessions.has(run.sessionId)&&!terminal.has(run.status));
      const sessions=await this.harness.rpc('session.list');
      const nativeRunning=sessions.items.some((item:any)=>relatedSessions.has(item.sessionId)&&item.running);
      if(active||nativeRunning)throw Error('任务执行中，请先停止再归档');
    }
    const updated=this.store.put('tasks',{id:task.id,archivedAt:archived?new Date().toISOString():null});
    this.emit({type:'task',task:updated});return updated;
  }
  context(sessionId: string, cwd?: string, query='') {
    const projectId=this.projectForSession(sessionId) || this.store.list('projects').find(p=>p.path===cwd)?.id;
    const files:any[]=[];
    const core=this.memory.read('MEMORY.md');const coreContent=relevant(core.content,query,700)||compact(core.content,350);if(coreContent)files.push({...core,content:coreContent});
    if(projectId) {
      const overview=this.memory.read(`projects/${projectId}/overview.md`);const overviewContent=relevant(overview.content,query,600)||compact(overview.content,400);if(overviewContent)files.push({...overview,content:overviewContent});
      for(const name of ['decisions','progress']) {
        const file=this.memory.read(`projects/${projectId}/${name}.md`);const content=relevant(file.content,query,500);if(content)files.push({...file,content});
      }
    }
    return {projectId,files,todos:this.store.list('todos').filter(t=>!t.projectId||t.projectId===projectId),plans:this.store.list('plans').filter(p=>p.projectId===projectId).slice(0,8),time:new Date().toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  }
  async submit(sessionId: string, text: string, source='user', planId?: string) {
    if(typeof text!=='string'||!text.trim()||text.length>100000)throw Error('请输入有效任务内容');
    const task=await this.adopt(sessionId);
    const plan=planId?this.store.get('plans',planId):undefined;
    if(planId&&(!plan||plan.projectId!==task.projectId))throw Error('方案不存在或不属于当前项目');
    const discussion=task.kind==='review'?this.store.put('discussions',{taskId:task.id,sessionId,projectId:task.projectId,title:`方案工作稿：${text.trim().slice(0,48)}`,brief:text.trim(),stage:'brief',status:'working',sections:{},revision:revision('{}')}):undefined;
    const run=this.store.put('runs',{taskId:task.id,sessionId,projectId:task.projectId,text,source,kind:task.kind,status:'queued',planId,planContent:plan?.content,discussionId:discussion?.id,baselineSeq:-1});
    if(discussion)this.emit({type:'discussion',discussion});
    this.emit({type:'run',run});return run;
  }
  async dispatch() {
    if(this.busy||this.stopping)return;this.busy=true;
    try {
      const runs=this.store.list('runs');
      for(const run of runs.filter(r=>r.status==='queued').reverse()) {
        const item=run.workItemId?this.store.get('workItems',run.workItemId):undefined;
        if(item) {
          const dependencies=(item.dependencies||[]).map((id:string)=>this.store.get('workItems',id)).filter(Boolean);
          const failed=dependencies.find((dependency:any)=>['failed','stopped','interrupted','blocked'].includes(dependency.status));
          if(failed) {
            const blocked=this.store.put('runs',{id:run.id,status:'failed',error:`依赖任务“${failed.title}”未完成`,finishedAt:new Date().toISOString()});
            this.store.put('workItems',{id:item.id,status:'blocked',error:blocked.error,finishedAt:blocked.finishedAt});this.updateExecution(item.parentTaskId);continue;
          }
          if(dependencies.some((dependency:any)=>dependency.status!=='completed'))continue;
        }
        const active=this.store.list('runs').filter(r=>['running','waiting','stopping','settling'].includes(r.status));
        if(active.some(r=>{
          if(r.sessionId===run.sessionId)return true;
          if(!run.projectId||r.projectId!==run.projectId||r.kind==='skill'||run.kind==='skill')return false;
          const activeItem=r.workItemId?this.store.get('workItems',r.workItemId):undefined;
          return item?.mode!=='read'||activeItem?.mode!=='read';
        }))continue;
        if(this.sessionLocks.has(run.sessionId))continue;
        this.sessionLocks.add(run.sessionId);
        try {
          await this.ensureUsableModel(run.sessionId);
          const history=await this.harness.rpc('session.history',{sessionId:run.sessionId,maxMessages:100});
          const baseline=Math.max(-1,...history.events.map((e:any)=>e.event.seq));
          const updated=this.store.put('runs',{id:run.id,status:'running',baselineSeq:baseline,startedAt:new Date().toISOString()});
          if(item)this.store.put('workItems',{id:item.id,status:'running',startedAt:updated.startedAt});
          this.emit({type:'run',run:updated});
          const task=this.store.get('tasks',run.taskId)!;
          const context=this.context(run.sessionId,undefined,run.text);
          // Queue context separately so the real user message and slash commands
          // retain their native shape in Harness history.
          const mem=context.files.map(f=>`## ${f.name}\n${f.content}`).join('\n\n');
          let prompt=run.text;
          const prefix=`[Loom 当前工作上下文，记录可能包含建议或假设，不代表新的执行授权]\n${mem}\n${run.planContent?`已选定方案 ${run.planId}:\n${run.planContent}`:''}\n[/Loom]\n\n`;
          if(task.kind==='review')prompt=`这是用户明确启动的双 Agent 文档协作。共享方案工作稿 ID：${run.discussionId}。只解决本次题目，不追溯历史任务，不读取其他项目或工作台数据库。主 Agent 不做额外调查、不运行 sleep 或轮询，启动协作者后等待自动结算通知。\n1. 启动一个可继续的“创新 Agent”。它只读共享稿和题目中必要材料，最多做 2 次证据检查；以 section=innovation 写最多 3 个方向、取舍与推荐，600–900 字，然后 report。\n2. 收到结算通知后再启动一个“工程 Agent”。它读同一稿，最多做 2 次证据检查；以 section=engineering-review 写可行性、关键风险和最多 3 个修改意见，700–1000 字，然后 report。\n3. 用 send_message 要求原创新 Agent 以 section=innovation-revision 吸收评审、600–900 字完成修订并 report；不启动第三个 Agent。\n4. 用 send_message 要求原工程 Agent 以 section=engineering-delivery 写最小实现、涉及模块、验收方式和不做范围，700–1000 字，并在 update payload 中附带 workItems：1–4 个执行项，每项为 {title,objective,mode:\"read\"|\"write\",dependsOn:前序执行项的零基索引数组,deliverables:字符串数组,preview:布尔值}。\n5. 你读稿后以 section=final 写共识、仅剩分歧、推荐选择和待用户确认项，500–700 字。四个章节完成前不得最终答复。\n两个 Agent 只通过这份稿交流，不修改项目文件。调用：loom_work operation=discussion，payload 为 {\"action\":\"get\",\"id\":\"${run.discussionId}\"} 或 {\"action\":\"update\",\"id\":\"${run.discussionId}\",\"section\":\"...\",\"content\":\"...\",\"revision\":\"先 get 的 revision\",\"workItems\":\"仅 engineering-delivery 使用\"}。\n${prompt}`;
          if(/^\/[a-z][\w-]*\s/i.test(prompt)) prompt=prompt.replace(/^(\/[a-z][\w-]*\s)/i,`$1${prefix}`);
          else prompt=prefix+prompt;
          if(run.text.startsWith('/')) {
            const modeOnly=/^\/plan(?:\s+off)?\s*$/.test(run.text);
            const line=modeOnly?run.text:prompt.startsWith('/')?prompt:run.text;
            // rc.7 mounts commands on the generated remote API. session.prompt
            // treats slash text as a model message despite old type comments.
            const receipt=await this.harness.rpc('commands/execute',{args:{agentId:run.sessionId,line}});
            if(!receipt||receipt.result?.kind!=='success')throw Error(receipt?.result?.text||'命令不存在');
            this.emit({type:'command',sessionId:run.sessionId,text:receipt.result.text});
            if(modeOnly)this.finish(updated,{data:{reason:{kind:'completed'}},seq:baseline});
          } else await this.harness.rpc('session.prompt',{sessionId:run.sessionId,mode:'queue',content:[{type:'text',text:prompt}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
        } catch(e) {const failed=this.store.put('runs',{id:run.id,status:'interrupted',error:String(e),finishedAt:new Date().toISOString()});if(run.workItemId){const item=this.store.get('workItems',run.workItemId);this.store.put('workItems',{id:run.workItemId,status:'interrupted',error:String(e),finishedAt:failed.finishedAt});this.updateExecution(item?.parentTaskId);}this.emit({type:'run',run:failed});}
        finally {this.sessionLocks.delete(run.sessionId);}
      }
    } finally {this.busy=false;}
  }
  onFrame(frame: Frame) {
    const p=frame.payload;this.emit({type:'harness',frame});
    if(!p.sessionId)return;
    const run=this.store.list('runs').find(r=>r.sessionId===p.sessionId&&!r.finishedAt&&['running','waiting','stopping','settling','interrupted'].includes(r.status));
    if(!run)return;
    if(p.type==='question/requested'||p.type==='approval/requested') {this.store.put('runs',{id:run.id,status:'waiting'});if(run.workItemId)this.store.put('workItems',{id:run.workItemId,status:'waiting'});}
    if(p.type==='question/resolved'||p.type==='approval/resolved') {this.store.put('runs',{id:run.id,status:'running'});if(run.workItemId)this.store.put('workItems',{id:run.workItemId,status:'running'});}
    if(p.type==='session/event'&&p.event?.type==='turn/start'&&p.event.seq>run.baselineSeq)this.store.put('runs',{id:run.id,status:'running'});
    if(p.type==='session/event'&&p.event?.type==='turn/end'&&p.event.seq>run.baselineSeq) {
      if(p.event.data.reason.kind==='completed')this.store.put('runs',{id:run.id,status:'settling'});
      else this.finish(run,p.event);
    }
  }
  finish(run: Row,event: any) {
    if(this.store.get('runs',run.id)?.finishedAt)return;
    if(terminal.has(this.store.get('runs',run.id)?.status) && run.status!=='interrupted')return;
    const status=this.store.get('runs',run.id)?.cancelRequested?'stopped':endStatus(event.data.reason);
    const result=this.store.put('runs',{id:run.id,status,reason:event.data.reason,finishedAt:new Date().toISOString()});
    if(run.workItemId) {
      const item=this.store.get('workItems',run.workItemId);if(item)this.store.put('workItems',{id:item.id,status,error:status==='completed'?null:event.data.reason?.message||result.error,finishedAt:result.finishedAt});
      this.updateExecution(item?.parentTaskId);
    }
    this.emit({type:'run',run:result});
    const notification=this.store.put('notifications',{id:run.id,title:status==='completed'?'任务执行结束':'任务需要关注',text:this.store.get('tasks',run.taskId)?.title||run.text.slice(0,60),sessionId:run.sessionId,runId:run.id,read:false});
    this.emit({type:'notification',notification});
  }
  updateExecution(parentTaskId?: string) {
    if(!parentTaskId)return;
    const items=this.store.list('workItems').filter(item=>item.parentTaskId===parentTaskId);if(!items.length)return;
    const status=items.every(item=>item.status==='completed')?'completed':items.some(item=>['failed','stopped','interrupted','blocked'].includes(item.status))?'needs-attention':items.some(item=>['running','waiting'].includes(item.status))?'running':'queued';
    const discussion=this.store.list('discussions').find(row=>row.taskId===parentTaskId);
    if(discussion) {const updated=this.store.put('discussions',{id:discussion.id,executionStatus:status});this.emit({type:'workflow',parentTaskId,status,discussion:updated});}
  }
  async reconcile() {
    const active=this.store.list('runs').filter(r=>!r.finishedAt&&['running','waiting','stopping','settling','interrupted'].includes(r.status));
    if(!active.length)return;
    const listed=await this.harness.rpc('session.list');
    for(const run of active) {
      if(this.sessionLocks.has(run.sessionId))continue;
      const session=listed.items.find((s:any)=>s.sessionId===run.sessionId);
      if(!session) {const failed=this.store.put('runs',{id:run.id,status:'interrupted',error:'原会话不可用，需要人工恢复',finishedAt:new Date().toISOString()});if(run.workItemId){const item=this.store.get('workItems',run.workItemId);this.store.put('workItems',{id:run.workItemId,status:'interrupted',error:failed.error,finishedAt:failed.finishedAt});this.updateExecution(item?.parentTaskId);}continue;}
      const h=await this.harness.rpc('session.history',{sessionId:run.sessionId,maxMessages:100});
      const events=h.events.map((e:any)=>e.event).filter((e:any)=>e.seq>run.baselineSeq);
      const end=events.filter((e:any)=>e.type==='turn/end').at(-1);
      const start=events.filter((e:any)=>e.type==='turn/start').at(-1);
      if(session.running||start&&(!end||start.seq>end.seq))continue;
      if(end) {
        if(end.data.reason.kind==='completed') {
          const children=await this.harness.rpc('subagent.list',{parentSessionId:run.sessionId});
          if(children.entries?.some((c:any)=>c.activity==='running'))continue;
          if(end.time&&Date.now()-end.time<3000)continue;
          const task=this.store.get('tasks',run.taskId);
          if(task?.kind==='review') {
            const discussion=this.store.get('discussions',run.discussionId);
            if((children.entries||[]).length!==2||discussion?.stage!=='final') {
              this.finish(run,{...end,data:{reason:{kind:'error',message:'双 Agent 未完成共享文档交接'}}});continue;
            }
          }
        }
        this.finish(run,end);
      }
      else if(!session.running&&run.status!=='interrupted')this.store.put('runs',{id:run.id,status:'interrupted',error:'执行未记录结束，未自动重试'});
    }
  }
  async cancel(sessionId: string) {
    const task=this.store.list('tasks').find(row=>row.sessionId===sessionId);
    const managed=[sessionId,...this.store.list('tasks').filter(row=>row.parentTaskId===task?.id).map(row=>row.sessionId)];
    for(const managedId of managed) {
      for(const r of this.store.list('runs').filter(r=>r.sessionId===managedId&&r.status==='queued')) {this.store.put('runs',{id:r.id,status:'stopped',finishedAt:new Date().toISOString()});if(r.workItemId)this.store.put('workItems',{id:r.workItemId,status:'stopped',finishedAt:new Date().toISOString()});}
      for(const r of this.store.list('runs').filter(r=>r.sessionId===managedId&&['running','waiting','settling'].includes(r.status)))this.store.put('runs',{id:r.id,status:'stopping',cancelRequested:true});
      const children=await this.harness.rpc('subagent.list',{parentSessionId:managedId}).catch(()=>({entries:[]}));
      for(const child of children.entries||[])if(child.activity==='running') {
        if(child.mode==='continuable')await this.harness.rpc('subagent.interrupt',{parentSessionId:managedId,childSessionId:child.id,mode:child.mode}).catch(()=>{});
        else await this.harness.rpc('session.cancel',{sessionId:child.id}).catch(()=>{});
      }
      await this.harness.rpc('session.cancel',{sessionId:managedId}).catch(()=>{});
    }
    if(task)this.updateExecution(task.parentTaskId||task.id);
    this.emit({type:'changed'});return {accepted:true};
  }
  work(operation: string,args: any,sessionId?: string,cwd?: string,author=false): any {
    if(author&&!['context','draft'].includes(operation))throw Error('草稿会话只能读取上下文和提交草稿');
    const projectId=sessionId?this.projectForSession(sessionId):args.projectId;
    if(operation==='context')return this.context(sessionId||'',cwd);
    if(operation==='list')return this.snapshot();
    if(operation==='draft') {
      const meta=validateSkill(args.content);const previous=this.store.list('drafts').find(d=>d.sessionId===sessionId&&d.status==='draft');
      const draft=this.store.put('drafts',{id:previous?.id,sessionId,content:args.content,...meta,status:'draft',revision:revision(args.content)});this.emit({type:'draft',draft});return draft;
    }
    if(operation==='todo') {
      if(typeof args.text!=='string'||!args.text.trim())throw Error('待办不能为空');
      const row=this.store.put('todos',{id:args.id,text:args.text.slice(0,1000),done:!!args.done,projectId});this.emit({type:'changed'});return row;
    }
    if(operation==='schedule') {
      if(!['reminder','task'].includes(args.kind)||!['once','daily','weekly'].includes(args.recurrence))throw Error('安排类型无效');
      if(typeof args.title!=='string'||!args.title.trim()||!Number.isFinite(Date.parse(args.nextAt))||!/(Z|[+-]\d\d:\d\d)$/.test(args.nextAt))throw Error('安排需要标题和带时区的有效时间');
      new Intl.DateTimeFormat('en',{timeZone:args.timezone}).format();
      if(args.kind==='task'&&(!args.prompt||!String(args.prompt).trim()))throw Error('执行任务需要具体内容');
      if(projectId)this.project(projectId);
      const row=this.store.put('schedules',{id:args.id,title:args.title,prompt:args.prompt||'',kind:args.kind,nextAt:new Date(args.nextAt).toISOString(),timezone:args.timezone,recurrence:args.recurrence,projectId,enabled:args.enabled!==false});this.emit({type:'changed'});return row;
    }
    if(operation==='memory') {
      const allowed=['MEMORY.md',...(projectId?['overview','decisions','progress'].map(n=>`projects/${projectId}/${n}.md`):[])];
      if(!allowed.includes(args.name))throw Error('只能修改个人记忆或当前项目记忆');
      const result=this.memory.write(args.name,args.content,args.revision);this.emit({type:'memory',name:args.name});return result;
    }
    if(operation==='discussion') {
      const row=this.store.get('discussions',args.id);if(!row)throw Error('方案工作稿不存在');
      if(args.action==='get')return {...row,content:renderDiscussion(row)};
      if(args.action!=='update'||!discussionNext[args.section])throw Error('方案工作稿操作无效');
      if(row.status!=='working'||row.stage!==discussionNext[args.section])throw Error(`方案工作稿当前阶段为 ${row.stage}，不能写入 ${args.section}`);
      if(args.revision!==row.revision)throw Error('方案工作稿已更新，请重新读取后再修改');
      const limits: Record<string,number>={innovation:1200,'engineering-review':1400,'innovation-revision':1200,'engineering-delivery':1400,final:1000};
      if(typeof args.content!=='string'||!args.content.trim()||args.content.length>limits[args.section])throw Error(`方案章节超过 ${limits[args.section]} 字，请只保留结论和必要依据`);
      const sections={...(row.sections||{}),[args.section]:args.content.trim()};
      const workItems=args.section==='engineering-delivery'?normalizeWorkItems(args.workItems,args.content):row.workItems;
      const updated=this.store.put('discussions',{id:row.id,sections,workItems,stage:args.section,status:args.section==='final'?'pending-confirmation':'working',revision:revision(JSON.stringify({sections,workItems}))});
      this.emit({type:'discussion',discussion:updated});return {...updated,content:renderDiscussion(updated)};
    }
    if(operation==='plan') {
      if(!projectId||typeof args.content!=='string'||!args.content.trim())throw Error('方案需要项目和内容');
      if(!['proposed','decided','hypothesis','discarded'].includes(args.status))throw Error('方案状态无效');
      const row=this.store.put('plans',{projectId,title:args.title||'项目方案',content:args.content,status:args.status,sessionId,version:this.store.list('plans').filter(p=>p.projectId===projectId).length+1});this.emit({type:'changed'});return row;
    }
    if(operation==='artifact') {
      const project=this.project(projectId); const root=project?.path||join(this.root,'artifacts');
      const path=safePath(root,args.path);if(!existsSync(path)||!statSync(path).isFile())throw Error('产出文件不存在');
      const task=sessionId?this.store.list('tasks').find(t=>t.sessionId===sessionId):undefined;
      const previous=this.store.list('artifacts').find(item=>item.projectId===projectId&&item.path===args.path&&item.sessionId===sessionId);
      const row=this.store.put('artifacts',{id:previous?.id,projectId,title:args.title||args.path,path:args.path,sessionId,taskId:task?.id,parentTaskId:task?.parentTaskId,status:'exists'});
      const preview=this.registerArtifactPreview(row,task);if(!preview)this.emit({type:'changed'});return {...row,preview};
    }
    if(operation==='preview') {
      const task=sessionId?this.store.list('tasks').find(t=>t.sessionId===sessionId):undefined;
      const effectiveProjectId=task?.projectId||projectId||args.projectId;const project=this.project(effectiveProjectId);
      let sourceType=String(args.sourceType||''),entryPath:string|undefined,url:string|undefined,artifactId:string|undefined;
      if(sourceType==='static-html'||sourceType==='markdown'||args.path) {
        entryPath=String(args.entryPath||args.path||'');sourceType=filePreviewType(entryPath)||sourceType;if(!['static-html','markdown'].includes(sourceType))throw Error('文件预览只支持 HTML 或 Markdown');
        const root=project?.path||join(this.root,'artifacts');const file=safePath(root,entryPath);if(!existsSync(file)||!statSync(file).isFile())throw Error('预览入口文件不存在');
        const existing=this.store.list('artifacts').find(item=>item.projectId===effectiveProjectId&&item.path===entryPath&&item.sessionId===sessionId);
        const artifact=this.store.put('artifacts',{id:existing?.id,projectId:effectiveProjectId,title:args.title||entryPath,path:entryPath,sessionId,taskId:task?.id,parentTaskId:task?.parentTaskId,status:'exists',kind:'preview'});artifactId=artifact.id;
      } else {
        const parsed=new URL(String(args.url||''));if(!['http:','https:'].includes(parsed.protocol))throw Error('预览地址必须使用 http 或 https');
        const local=['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname);sourceType=local?'local-url':'external-url';url=parsed.href;
      }
      const previous=artifactId?this.store.list('previews').find(item=>item.artifactId===artifactId):undefined;
      const row=this.store.put('previews',{id:previous?.id,projectId:effectiveProjectId,taskId:task?.id,parentTaskId:task?.parentTaskId,sessionId,title:String(args.title||entryPath||url||'网页预览').slice(0,160),sourceType,entryPath,url,artifactId,status:'ready'});
      if(task?.workItemId)this.store.put('workItems',{id:task.workItemId,previewId:row.id});
      this.emit({type:'preview',preview:row});return row;
    }
    throw Error('未知工作台操作');
  }
  skills() {return listSkills([join(this.root,'skills'),join(this.dshHome,'skills')]);}
  async confirmDiscussion(id: string): Promise<any> {
    const row=this.store.get('discussions',id);if(!row||row.status!=='pending-confirmation'||row.stage!=='final')throw Error('方案尚未完成或已经处理');
    const parent=this.store.get('tasks',row.taskId);if(!parent)throw Error('评审父任务不存在');
    const project=this.project(row.projectId);if(project&&(!project.path||!existsSync(project.path)))throw Error('请先重新绑定项目文件夹');
    const content=renderDiscussion(row),handoff=executionBrief(row),drafts=normalizeWorkItems(row.workItems,row.sections?.['engineering-delivery']||content);
    const current=await this.harness.rpc('session.models',{sessionId:row.sessionId});
    const selection=current.current?.provider&&current.current?.model?current.current:{provider:parent.provider,model:parent.model,reasoningEffort:parent.reasoningEffort};
    if(!selection?.provider||!selection?.model)throw Error('父任务没有可继承的模型，请先在模型设置中完成配置');
    const native:any[]=[];
    try {
      for(const draft of drafts) {
        const created=await this.harness.rpc('session.create',{cwd:project?.path||this.root,agentPreset:'loom-work'});
        await this.ensureUsableModel(created.sessionId,selection);await this.harness.rpc('session.rename',{sessionId:created.sessionId,title:draft.title});native.push(created);
      }
    } catch(error) {
      for(const created of native)await this.harness.rpc('session.cancel',{sessionId:created.sessionId}).catch(()=>{});
      throw error;
    }
    const workIds=drafts.map(()=>randomUUID()),taskIds=drafts.map(()=>randomUUID());let plan:any,updated:any;const tasks:any[]=[],workItems:any[]=[];
    try {
      this.store.transaction(()=>{
        if(row.projectId)plan=this.store.put('plans',{projectId:row.projectId,title:row.title,content,status:'decided',sessionId:row.sessionId,version:this.store.list('plans').filter(p=>p.projectId===row.projectId).length+1});
        drafts.forEach((draft,index)=>{
          const workItem=this.store.put('workItems',{id:workIds[index],discussionId:row.id,parentTaskId:parent.id,projectId:row.projectId,title:draft.title,objective:draft.objective,mode:draft.mode,dependencies:draft.dependsOn.map(dep=>workIds[dep]),deliverables:draft.deliverables,previewExpected:draft.preview,order:index,status:'queued'});workItems.push(workItem);
          const task=this.store.put('tasks',{id:taskIds[index],sessionId:native[index].sessionId,projectId:row.projectId,kind:'work',title:draft.title,parentTaskId:parent.id,workItemId:workItem.id,role:'execution',provider:selection.provider,model:selection.model,reasoningEffort:selection.reasoningEffort});tasks.push(task);
          const previewInstruction=draft.preview?'如果产出可预览页面，完成后必须调用 loom_work operation=preview 登记静态 HTML 路径或 http/https 地址。':'';
          this.store.put('runs',{taskId:task.id,sessionId:task.sessionId,projectId:row.projectId,text:`执行已确认方案中的一个独立工作项。\n\n工作项：${draft.title}\n目标：${draft.objective}\n预期产出：${draft.deliverables.join('、')||'可验证结果'}\n${previewInstruction}\n只处理本工作项；完成后验证并登记真实产出。`,source:'confirmed-plan',kind:'work',status:'queued',planId:plan?.id,planContent:handoff,contextPolicy:'minimal-v1',workItemId:workItem.id,parentTaskId:parent.id,baselineSeq:-1});
        });
        updated=this.store.put('discussions',{id,status:'confirmed',planId:plan?.id,confirmedAt:new Date().toISOString(),executionStatus:'queued',workItemIds:workIds});
      });
    } catch(error) {
      for(const created of native)await this.harness.rpc('session.cancel',{sessionId:created.sessionId}).catch(()=>{});
      throw error;
    }
    this.emit({type:'discussion',discussion:updated});for(const task of tasks)this.emit({type:'task',task});this.emit({type:'workflow',parentTaskId:parent.id,status:'queued'});await this.dispatch();
    return {...updated,content,plan,workItems,tasks};
  }
  approveDraft(id: string, expected: string, content: string) {
    const draft=this.store.get('drafts',id);if(!draft||draft.status!=='draft'||draft.revision!==expected)throw Error('草稿已改变或已处理，请重新加载');
    const meta=validateSkill(content);const path=safePath(join(this.root,'skills'),`${meta.name}/SKILL.md`);
    if(this.skills().some(s=>s.name===meta.name))throw Error('同名 Skill 已存在，请换名，避免覆盖');
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content,{flag:'wx',mode:0o600});
    const result=this.store.put('drafts',{id,status:'saved',content,...meta,revision:revision(content),path});this.emit({type:'draft',draft:result});return result;
  }
  async tick(now=Date.now()) {
    if(this.ticking||this.stopping)return;this.ticking=true;
    try {
      for(const s of this.store.list('schedules').filter(s=>s.enabled&&Date.parse(s.nextAt)<=now)) {
        const runId=randomUUID(); const late=now-Date.parse(s.nextAt)>120000;
        const claimed=this.store.transaction(()=>{
          if(!this.store.claim(s.id,s.nextAt,runId))return false;
          const next=nextOccurrence(s.nextAt,s.recurrence,s.timezone,now);
          this.store.put('schedules',{id:s.id,nextAt:next||s.nextAt,enabled:!!next,lastDue:s.nextAt});
          this.store.put('notifications',{id:runId,title:s.title,text:late?'错过的安排，尚未补跑':s.kind==='reminder'?'提醒时间到了':'定时任务已到执行时间',scheduleId:s.id,read:false,missed:late});
          if(s.kind==='task'&&!late)this.store.put('runs',{id:runId,status:'scheduled',scheduleId:s.id,text:s.prompt,projectId:s.projectId,kind:'work',source:'schedule'});
          return true;
        });
        if(claimed)this.emit({type:'notification',notification:this.store.get('notifications',runId)});
      }
      for(const run of this.store.list('runs').filter(r=>r.status==='scheduled')) {
        // Persist the intermediate state before awaiting; a restart never
        // silently repeats a partially dispatched side-effectful operation.
        this.store.put('runs',{id:run.id,status:'preparing'});
        try {const task=await this.createTask({projectId:run.projectId,title:this.store.get('schedules',run.scheduleId)?.title||'定时任务'});this.store.put('runs',{id:run.id,taskId:task.id,sessionId:task.sessionId,status:'queued',baselineSeq:-1});}
        catch(e){this.store.put('runs',{id:run.id,status:'failed',error:String(e)});}
      }
      await this.dispatch();
    }finally{this.ticking=false;}
  }
  exportData() {
    // Explicit allowlist: no settings, credentials, environment, runtime logs,
    // API keys or absolute machine paths are part of the portable archive.
    const projects=this.store.list('projects').map(({id,title})=>({id,title}));
    const data: any={format:'loom-portable',version:1,exportedAt:new Date().toISOString(),projects,files:{},records:{}};
    for(const name of this.memory.list())data.files[`memory/${name}`]=this.memory.read(name).content;
    for(const skill of this.skills())data.files[`skills/${skill.name}/SKILL.md`]=skill.content;
    for(const kind of ['todos','plans','schedules','artifacts'] as Kind[])data.records[kind]=this.store.list(kind).map(({sessionId,path,...row})=>({...row,...(kind==='artifacts'?{path}:{}),...(kind==='schedules'?{enabled:false}:{} )}));
    data.records.previews=this.store.list('previews').filter(row=>row.sourceType==='static-html').map(({sessionId,taskId,parentTaskId,url,...row})=>row);
    for(const name of walk(join(this.root,'artifacts'))) {const p=safePath(join(this.root,'artifacts'),name);if(statSync(p).size<=2_000_000)data.files[`artifacts/${name}`]={base64:readFileSync(p).toString('base64')};}
    return data;
  }
  importData(data: any) {
    if(data?.format!=='loom-portable'||data.version!==1||!Array.isArray(data.projects)||!data.files||!data.records)throw Error('迁移包格式不支持');
    const importId=randomUUID();const staging=join(this.root,'imports',importId);const map=new Map<string,string>();
    for(const p of data.projects) {if(typeof p.id!=='string'||typeof p.title!=='string'||map.has(p.id))throw Error('项目数据无效');map.set(p.id,randomUUID());}
    for(const kind of ['todos','plans','schedules','artifacts']) {
      if(data.records[kind]!==undefined&&!Array.isArray(data.records[kind]))throw Error('迁移记录格式无效');
      for(const raw of data.records[kind]||[]) {
        if(!raw||typeof raw!=='object'||(raw.projectId&&!map.has(raw.projectId)))throw Error('记录关联的项目不存在');
        if(kind==='artifacts')safePath(this.root,raw.path);
        if(kind==='schedules') {
          if(!['once','daily','weekly'].includes(raw.recurrence)||!['task','reminder'].includes(raw.kind)||!Number.isFinite(Date.parse(raw.nextAt)))throw Error('迁移安排无效');
          new Intl.DateTimeFormat('en',{timeZone:raw.timezone}).format();
        }
      }
    }
    if(data.records.previews!==undefined&&!Array.isArray(data.records.previews))throw Error('迁移预览格式无效');
    for(const preview of data.records.previews||[]) {
      if(preview.sourceType!=='static-html'||typeof preview.entryPath!=='string'||(preview.projectId&&!map.has(preview.projectId)))throw Error('迁移预览格式无效');
      safePath(this.root,preview.entryPath);
    }
    const files: {path:string;content:string|Buffer}[]=[];
    for(const [name,value] of Object.entries(data.files)) {
      if(!/^(memory|skills|artifacts)\//.test(name))throw Error('迁移包包含不允许的文件');
      const path=safePath(staging,name);
      if(name.startsWith('skills/')) {
        const skill=validateSkill(value as string);
        if(name!==`skills/${skill.name}/SKILL.md`)throw Error('Skill 文件名与元信息不一致');
      }
      if(name.startsWith('memory/')) {
        this.memory.path(name.slice(7));
        if(typeof value!=='string'||value.length>200000)throw Error('记忆格式无效');
        if(name.startsWith('memory/projects/')&&!map.has(name.split('/')[2]))throw Error('记忆所属项目不存在');
      }
      if(typeof value==='string')files.push({path,content:value});
      else if(name.startsWith('artifacts/')&&typeof (value as any)?.base64==='string')files.push({path,content:Buffer.from((value as any).base64,'base64')});
      else throw Error('迁移文件无效');
    }
    for(const file of files){mkdirSync(dirname(file.path),{recursive:true});writeFileSync(file.path,file.content,{flag:'wx',mode:0o600});}
    this.store.transaction(()=>{
      for(const p of data.projects)this.store.put('projects',{id:map.get(p.id),title:p.title,path:null,importId});
      for(const kind of ['todos','plans','schedules','artifacts'] as Kind[])for(const raw of (data.records[kind]||[])) {
        const {id,sessionId,path,workspaceId,...rest}=raw;
        this.store.put(kind,{...rest,projectId:map.get(raw.projectId),...(kind==='artifacts'?{path:raw.projectId?path:`imports/${importId}/${path}`,status:raw.projectId?'needs-rebind':'imported'}:{}),...(kind==='schedules'?{enabled:false}:{}),importId});
      }
      for(const raw of data.records.previews||[]) {
        const {id,sessionId,taskId,parentTaskId,...rest}=raw;this.store.put('previews',{...rest,entryPath:raw.projectId?raw.entryPath:`imports/${importId}/${raw.entryPath}`,projectId:map.get(raw.projectId),status:raw.projectId?'unavailable':'ready',importId});
      }
    });
    for(const [name,value] of Object.entries(data.files)) {
      if(!name.startsWith('memory/'))continue;
      let target=name.slice(7);
      if(target.startsWith('projects/')) {const old=target.split('/')[1];if(!map.has(old))continue;target=target.replace(`projects/${old}/`,`projects/${map.get(old)}/`);}
      else if(target==='MEMORY.md'&&this.memory.read(target).content)target=`imported-${importId}.md`;
      this.memory.write(target,value as string,this.memory.read(target).revision);
    }
    // Skills are validated, staged, then installed only if the name is free.
    for(const [name,value] of Object.entries(data.files))if(name.startsWith('skills/')) {
      const meta=validateSkill(value as string);
      const target=safePath(this.root,name);if(!this.skills().some(s=>s.name===meta.name)&&!existsSync(target)){mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value as string,{flag:'wx',mode:0o600});}
    }
    for(const [name,value] of Object.entries(data.files))if(name.startsWith('artifacts/')) {
      const target=safePath(join(this.root,'artifacts'),`imports/${importId}/${name.slice(10)}`);
      mkdirSync(dirname(target),{recursive:true});writeFileSync(target,typeof value==='string'?value:Buffer.from((value as any).base64,'base64'),{flag:'wx',mode:0o600});
    }
    this.emit({type:'changed'});return {importId,projectIds:[...map.values()],staging,notes:'项目需重新绑定，导入的安排默认暂停；已有个人记忆未覆盖。历史会话仍保留在原设备 Harness 中。'};
  }
}
