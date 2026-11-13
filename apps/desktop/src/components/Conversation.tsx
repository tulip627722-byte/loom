import { CheckIcon } from '@phosphor-icons/react/Check';
import { XIcon } from '@phosphor-icons/react/X';
import { SpinnerGapIcon } from '@phosphor-icons/react/SpinnerGap';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Approval, Message, Plan, Task } from '@loom/shared';

interface ConversationProps {
  task?: Task;
  messages: Message[];
  plans: Plan[];
  approvals: Approval[];
  onApprovePlan(id: string): void;
  onApproveCommand(id: string): void;
  onApproveDangerous(id: string): void;
  onReject(id: string): void;
}

const statusText: Record<string, string> = {
  planning: 'Planner 正在整理方案', queued: '等待执行', running: '正在工作', 'awaiting-plan': '等待确认方案', 'awaiting-approval': '等待操作批准', completed: '已完成', failed: '执行失败', cancelled: '已取消', idle: '',
};

export function Conversation({ task, messages, plans, approvals, onApprovePlan, onApproveCommand, onApproveDangerous, onReject }: ConversationProps) {
  if (!task) return <div className="empty-state"><div className="loom-mark">L</div><h1>今天想完成什么？</h1><p>可以先讨论方案，也可以直接把任务交给不同模型协作完成。</p></div>;
  const taskPlans = plans.filter(plan => plan.taskId === task.id);
  const taskApprovals = approvals.filter(approval => approval.taskId === task.id && approval.status === 'pending');
  return <div className="conversation" aria-live="polite">
    {messages.map(message => <article key={message.id} className={`message is-${message.role}`}>
      {message.role === 'assistant' && message.agentRole ? <span className="agent-label">{message.agentRole}</span> : null}
      <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
    </article>)}
    {taskPlans.map(plan => <section key={plan.id} className="approval-card plan-card">
      <header><div><span className="eyebrow">PLAN</span><h2>{plan.summary}</h2></div><span>{plan.steps.length} 步</span></header>
      <ol>{plan.steps.map(step => <li key={step.id}><span>{step.title}</span><small>{step.role}</small></li>)}</ol>
      {plan.acceptance.length ? <details><summary>验收标准</summary><ul>{plan.acceptance.map(item => <li key={item}>{item}</li>)}</ul></details> : null}
      {plan.status === 'pending' ? <footer><button className="secondary" onClick={() => onReject(taskApprovals.find(item => item.payload?.planId === plan.id)?.id || '')}>取消</button><button className="primary" onClick={() => onApprovePlan(plan.id)}><CheckIcon size={16} />确认并执行</button></footer> : <span className={`resolved is-${plan.status}`}>{plan.status === 'approved' ? '已批准' : '已处理'}</span>}
    </section>)}
    {taskApprovals.filter(item => item.kind === 'command').map(approval => <section key={approval.id} className="approval-card command-card">
      <span className="eyebrow">COMMAND</span><h2>{approval.title}</h2><code>{approval.detail}</code>
      <footer><button className="secondary" onClick={() => onReject(approval.id)}><XIcon size={16} />拒绝</button><button className="primary" onClick={() => onApproveCommand(approval.id)}><CheckIcon size={16} />允许一次</button></footer>
    </section>)}
    {taskApprovals.filter(item => item.kind === 'dangerous').map(approval => <section key={approval.id} className="approval-card merge-card">
      <span className="eyebrow">MERGE</span><h2>{approval.title}</h2><p>{approval.detail}</p>
      <footer><button className="secondary" onClick={() => onReject(approval.id)}>保留工作树</button><button className="primary" onClick={() => onApproveDangerous(approval.id)}><CheckIcon size={16} />确认合并</button></footer>
    </section>)}
    {['planning', 'queued', 'running'].includes(task.status) ? <div className="activity-line"><SpinnerGapIcon className="spin" size={16} /><span>{task.activeRole ? `${task.activeRole} · ` : ''}{statusText[task.status]}</span></div> : null}
  </div>;
}
