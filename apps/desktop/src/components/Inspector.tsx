import { XIcon } from '@phosphor-icons/react/X';
import type { Task } from '@loom/shared';

interface InspectorProps { open: boolean; task?: Task & { diff?: string; worktreePath?: string; error?: string }; onClose(): void }

export function Inspector({ open, task, onClose }: InspectorProps) {
  if (!open) return null;
  return <aside className="inspector" aria-label="任务检查器">
    <header><strong>任务详情</strong><button className="icon-button" onClick={onClose} aria-label="关闭检查器"><XIcon size={18} /></button></header>
    <dl><div><dt>状态</dt><dd>{task?.status || '—'}</dd></div><div><dt>角色</dt><dd>{task?.activeRole || '—'}</dd></div><div><dt>模型</dt><dd>{task?.modelId || '—'}</dd></div><div><dt>工作树</dt><dd className="path">{task?.worktreePath || '未创建'}</dd></div></dl>
    {task?.error ? <section><h3>错误</h3><pre>{task.error}</pre></section> : null}
    <section><h3>Diff</h3>{task?.diff ? <pre>{task.diff}</pre> : <p className="muted">任务完成后在这里查看改动。</p>}</section>
  </aside>;
}
