import { useEffect, useState } from 'react';
import { PlusIcon } from '@phosphor-icons/react/Plus';
import { TrashIcon } from '@phosphor-icons/react/Trash';
import { runtime } from '../runtime-client.ts';

interface MemoryItem { id: string; projectId?: string; name: string; content: string; revision: string }
interface MemoryPageProps { projectId?: string; onError(message: string): void }

export function MemoryPage({ projectId, onError }: MemoryPageProps) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [draft, setDraft] = useState({ name: '', content: '' });
  const active = items.find(item => item.id === activeId);
  const load = async () => {
    try { setItems(await runtime.listMemory(projectId)); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => { if (active) setDraft({ name: active.name, content: active.content }); }, [active?.id]);
  const create = () => { setActiveId(undefined); setDraft({ name: '', content: '' }); };
  const save = async () => {
    try {
      await runtime.saveMemory({ id: active?.id, projectId, name: draft.name, content: draft.content, expectedRevision: active?.revision });
      await load();
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  const remove = async () => {
    if (!active) return;
    try { await runtime.removeMemory(active.id); setActiveId(undefined); setDraft({ name: '', content: '' }); await load(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="memory-page page-scroll">
    <header className="page-title"><div><span className="eyebrow">MEMORY</span><h1>记忆</h1><p>{projectId ? '当前项目记忆不会泄漏到其他项目。' : '个人偏好只在个人空间中召回。'}</p></div><button className="secondary" onClick={create}><PlusIcon size={15} />新建</button></header>
    <div className="memory-layout">
      <nav aria-label="记忆列表">{items.length ? items.map(item => <button key={item.id} className={activeId === item.id ? 'is-active' : ''} onClick={() => setActiveId(item.id)}><strong>{item.name}</strong><span>{item.content.slice(0, 55) || '空记忆'}</span></button>) : <p>还没有记忆。</p>}</nav>
      <section className="memory-editor">
        <input aria-label="记忆标题" placeholder="标题" value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} />
        <textarea aria-label="记忆内容" placeholder="记录稳定偏好、项目事实或已确认决策…" value={draft.content} onChange={event => setDraft(value => ({ ...value, content: event.target.value }))} />
        <footer>{active ? <button className="danger-link" onClick={() => void remove()}><TrashIcon size={15} />删除</button> : <span />}<button className="primary" disabled={!draft.name.trim()} onClick={() => void save()}>保存记忆</button></footer>
      </section>
    </div>
  </div>;
}
