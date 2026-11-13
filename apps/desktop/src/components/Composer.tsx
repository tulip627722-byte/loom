import { ArrowUpIcon } from '@phosphor-icons/react/ArrowUp';
import { PaperclipIcon } from '@phosphor-icons/react/Paperclip';
import { StopIcon } from '@phosphor-icons/react/Stop';
import { useState } from 'react';
import type { TaskMode } from '@loom/shared';

interface ComposerProps {
  disabled?: boolean;
  running?: boolean;
  onSend(text: string, mode: TaskMode): Promise<void>;
  onStop?(): void;
}

export function Composer({ disabled, running, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<TaskMode>('plan');
  const submit = async () => {
    const value = text.trim();
    if (!value || disabled) return;
    setText('');
    try { await onSend(value, mode); }
    catch { setText(value); }
  };
  return <div className="composer-wrap">
    <div className="composer">
      <textarea aria-label="给 Loom 发任务" placeholder="描述你想完成的事…" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
      <div className="composer-actions">
        <div className="composer-left">
          <button className="icon-button quiet" aria-label="添加附件" disabled><PaperclipIcon size={18} /></button>
          <div className="mode-switch" aria-label="任务模式">
            <button className={mode === 'plan' ? 'is-active' : ''} onClick={() => setMode('plan')}>先计划</button>
            <button className={mode === 'direct' ? 'is-active' : ''} onClick={() => setMode('direct')}>直接执行</button>
          </div>
        </div>
        {running ? <button className="send-button" onClick={onStop} aria-label="停止任务"><StopIcon weight="fill" size={14} /></button> : <button className="send-button" onClick={() => void submit()} disabled={disabled || !text.trim()} aria-label="发送任务"><ArrowUpIcon weight="bold" size={17} /></button>}
      </div>
    </div>
    <small>Loom 可能会犯错。重要改动会在执行前请求确认。</small>
  </div>;
}
