import { ChatCircleIcon } from '@phosphor-icons/react/ChatCircle';
import { GearSixIcon } from '@phosphor-icons/react/GearSix';
import { PlusIcon } from '@phosphor-icons/react/Plus';
import { BrainIcon } from '@phosphor-icons/react/Brain';
import { FolderSimpleIcon } from '@phosphor-icons/react/FolderSimple';
import { SidebarSimpleIcon } from '@phosphor-icons/react/SidebarSimple';
import type { Project, Task } from '@loom/shared';

interface SidebarProps {
  collapsed: boolean;
  projects: Project[];
  tasks: Task[];
  activeTaskId?: string;
  activeProjectId?: string;
  view: 'chat' | 'memory' | 'settings';
  onToggle(): void;
  onNewTask(): void;
  onSelectTask(id: string): void;
  onSelectProject(id?: string): void;
  onView(view: 'chat' | 'memory' | 'settings'): void;
}

export function Sidebar(props: SidebarProps) {
  return <aside className={`sidebar ${props.collapsed ? 'is-collapsed' : ''}`} aria-label="主导航">
    <div className="sidebar-head">
      <button className="icon-button" onClick={props.onToggle} aria-label={props.collapsed ? '展开侧栏' : '收起侧栏'}><SidebarSimpleIcon size={20} /></button>
      {props.collapsed ? null : <strong className="wordmark">Loom</strong>}
    </div>
    <button className="new-task" onClick={props.onNewTask}><PlusIcon size={17} />{props.collapsed ? null : <span>新任务</span>}</button>
    <nav className="primary-nav">
      <button className={props.view === 'chat' ? 'is-active' : ''} onClick={() => props.onView('chat')}><ChatCircleIcon size={18} />{props.collapsed ? null : '对话'}</button>
      <button className={props.view === 'memory' ? 'is-active' : ''} onClick={() => props.onView('memory')}><BrainIcon size={18} />{props.collapsed ? null : '记忆'}</button>
      <button className={props.view === 'settings' ? 'is-active' : ''} onClick={() => props.onView('settings')}><GearSixIcon size={18} />{props.collapsed ? null : '设置'}</button>
    </nav>
    {props.collapsed ? null : <>
      <section className="sidebar-section">
        <span className="section-label">项目</span>
        <button className={!props.activeProjectId ? 'is-active' : ''} onClick={() => props.onSelectProject(undefined)}><FolderSimpleIcon size={16} />个人空间</button>
        {props.projects.map(project => <button key={project.id} className={props.activeProjectId === project.id ? 'is-active' : ''} onClick={() => props.onSelectProject(project.id)}><FolderSimpleIcon size={16} /><span className="truncate">{project.title}</span></button>)}
      </section>
      <section className="sidebar-section history-list">
        <span className="section-label">最近</span>
        {props.tasks.slice(0, 12).map(task => <button key={task.id} className={props.activeTaskId === task.id ? 'is-active' : ''} onClick={() => props.onSelectTask(task.id)}><span className={`status-dot is-${task.status}`} /><span className="truncate">{task.title}</span></button>)}
      </section>
    </>}
  </aside>;
}
