import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'tulip-bridge';
export const inject = ['tools','systemPrompt'];
export function apply(ctx, config = {}) {
  const request = async (operation, args, exec) => {
    const response = await fetch(`${process.env.TULIP_SERVICE_URL}/internal/work`, {method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.TULIP_BRIDGE_TOKEN}`},body:JSON.stringify({operation,args,sessionId:exec.agent?.session.id,cwd:exec.agent?.session.header.cwd,author:!!config.author}),signal:exec.signal});
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'Tulip 操作失败'); return JSON.stringify(result);
  };
  ctx.systemPrompt.section({name:'tulip-workbench',order:30,text:`你是 Tulip，用户的个人项目工作伙伴。用中文自然交流，模糊想法先讨论，明确任务直接执行。讨论中区分用户决定、建议、假设；不要虚构文件、执行结果或项目进展。开始一项工作和恢复旧工作时，先调用 tulip_context 读取最新个人与当前项目记忆，它会取代旧记忆摘要。需要保存偏好、项目进展、待办、安排、方案和产出时使用 tulip_work；工具成功后才报告保存成功。周期任务不会在电脑关机时运行。只有用户点击多视角评审时才启动两个子 Agent；它们必须通过同一份方案工作稿依次完成创新初稿、工程评审、创新修订和工程落地，不能用两个互不关联的回答代替，也不能启动第三个 Agent。普通任务不要调用子 Agent。`});
  ctx.tools.register(defineTool({name:'tulip_context',description:'读取最新个人偏好、当前项目记忆与工作摘要。每次用户开始新一轮工作时读取，删除的记忆不再作为当前依据。',parameters:{},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:(args,exec)=>request('context',args,exec)}));
  if (config.author) {
    ctx.tools.register(defineTool({name:'tulip_skill_draft',description:'提交或更新 Skill 草稿供用户编辑、确认；不会安装。Markdown 必须有 YAML name、description、metadata.category(product/development) 和正文。',parameters:{content:{type:'string',required:true}},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:(args,exec)=>request('draft',args,exec)}));
  } else {
    ctx.tools.register(defineTool({name:'tulip_work',description:'管理工作台数据。operation: list/todo/schedule/memory/plan/artifact/preview/discussion。payload 为 JSON 字符串。discussion 只操作共享方案工作稿：先 {action:get,id}，再按指定顺序 {action:update,id,section,content,revision}；engineering-delivery 还要提供 workItems 数组，每项含 title/objective/mode(read|write)/dependsOn/deliverables/preview。其他格式：todo:{text,done?,id?}; schedule:{title,prompt?,kind:reminder|task,nextAt:ISO带时区,timezone,recurrence:once|daily|weekly,id?,enabled?}; memory:{name,content,revision}; plan:{title,content,status}; artifact:{title,path} 登记真实产出，HTML 和 Markdown 会自动打开右侧预览；preview:{title,path} 可显式登记 HTML/Markdown，或 preview:{title,url} 登记已可访问的 http/https 地址。Markdown 中的 mermaid 代码块（包括 mindmap）会渲染为图。只有工具成功后才能报告产出或预览已登记。',parameters:{operation:{type:'string',required:true},payload:{type:'string',required:true}},output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute:(args,exec)=>request(args.operation,JSON.parse(args.payload),exec)}));
    const counts=new Map();
    ctx.tools.guard(exec=>{
      if (!['subagent','subagent_fork'].includes(exec.name)) return;
      const id=exec.agent?.session.id;
      const recorded=new Set((exec.agent?.session.events||[]).filter(e=>e.type==='tool/call'&&['subagent','subagent_fork'].includes(e.data?.name)&&e.data.callId!==exec.callId).map(e=>e.data.callId)).size;
      const count=Math.max(counts.get(id)||0,recorded);
      // A bounded review session has at most two delegate starts. Failed starts
      // also consume a slot rather than permitting unbounded retries.
      if(count>=2) return '本次协作已使用两个子 Agent；请整合结果或开始新的评审任务。';
      counts.set(id,count+1);
    });
  }
}
