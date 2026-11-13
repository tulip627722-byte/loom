import { useCallback, useEffect, useMemo, useState } from 'react';
import { InfoIcon } from '@phosphor-icons/react/Info';
import { PlusIcon } from '@phosphor-icons/react/Plus';
import type { Approval, Plan, RoleBinding, RuntimeSnapshot, Task } from '@loom/shared';
import { runtime } from './runtime-client.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { Composer } from './components/Composer.tsx';
import { Conversation } from './components/Conversation.tsx';
import { Inspector } from './components/Inspector.tsx';
import { Settings } from './components/Settings.tsx';
import { MemoryPage } from './components/MemoryPage.tsx';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const emptySnapshot: RuntimeSnapshot = { projects: [], tasks: [], messages: [], plans: [], approvals: [], roleBindings: [], models: [], gateway: { online: false, baseUrl: 'http://127.0.0.1:15721' }, latestEventSequence: 0 };

export function App() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(emptySnapshot);
  const [activeTaskId, setActiveTaskId] = useState<string>();
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [view, setView] = useState<'chat' | 'memory' | 'settings'>('chat');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try { setSnapshot(await runtime.snapshot()); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);

  useEffect(() => {
    let unsubscribe = () => {};
    const connect = async () => {
      try {
        const config = await invoke<{ runtimeUrl: string; token: string }>('start_runtime');
        runtime.configure(config);
      } catch {
        // Browser development mode uses the fixed local development token.
      }
      try {
        const initial = await runtime.snapshot();
        for (const model of initial.models) {
          if (!model.credentialRef) continue;
          try {
            const secret = await invoke<string>('read_credential', { account: model.credentialRef });
            await runtime.loadCredential(model.credentialRef, secret);
          } catch { /* Unavailable credentials remain disconnected. */ }
        }
        setSnapshot(initial);
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      unsubscribe = runtime.events(() => void reload());
    };
    void connect();
    return () => unsubscribe();
  }, [reload]);

  const activeTask = snapshot.tasks.find(task => task.id === activeTaskId) as (Task & { diff?: string; worktreePath?: string; error?: string }) | undefined;
  const taskMessages = useMemo(() => snapshot.messages.filter(message => message.taskId === activeTaskId).toReversed(), [snapshot.messages, activeTaskId]);
  const running = activeTask ? ['planning', 'queued', 'running'].includes(activeTask.status) : false;

  const send = async (prompt: string, mode: 'plan' | 'direct') => {
    const task = await runtime.createTask(activeProjectId, prompt, mode) as Task;
    setActiveTaskId(task.id); setView('chat'); await reload();
  };
  const act = async (operation: Promise<unknown>) => { try { await operation; await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const addProject = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择 Git 项目' });
      if (typeof selected !== 'string') return;
      await runtime.createProject(selected.split(/[\\/]/).at(-1) || '项目', selected);
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '请在 Tauri 桌面端选择项目目录'); }
  };

  return <div className="app-shell">
    <Sidebar collapsed={sidebarCollapsed} projects={snapshot.projects} tasks={snapshot.tasks} activeTaskId={activeTaskId} activeProjectId={activeProjectId} view={view} onToggle={() => setSidebarCollapsed(value => !value)} onNewTask={() => { setActiveTaskId(undefined); setView('chat'); }} onSelectTask={id => { setActiveTaskId(id); setView('chat'); }} onSelectProject={setActiveProjectId} onView={setView} />
    <main className="main-panel">
      <header className="topbar">
        <div><strong>{activeProjectId ? snapshot.projects.find(project => project.id === activeProjectId)?.title : '个人空间'}</strong>{activeTask ? <span>{activeTask.status}</span> : null}</div>
        <button className="icon-button" onClick={() => setInspectorOpen(value => !value)} aria-label="任务详情"><InfoIcon size={20} /></button>
      </header>
      {error ? <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div> : null}
      {view === 'settings' ? <Settings snapshot={snapshot} onRefresh={() => void act(runtime.refreshGateway())} onBind={(binding: RoleBinding) => void act(runtime.bindRole(binding))} onAddModel={(model, secret) => void act((async () => { await invoke('store_credential', { account: model.credentialRef, secret }); await runtime.loadCredential(model.credentialRef!, secret); return runtime.addModel(model); })())} /> : view === 'memory' ? <MemoryPage projectId={activeProjectId} onError={setError} /> : <>
        <div className="conversation-scroll"><Conversation task={activeTask} messages={taskMessages} plans={snapshot.plans as Plan[]} approvals={snapshot.approvals as Approval[]} onApprovePlan={id => void act(runtime.approvePlan(id))} onApproveCommand={id => void act(runtime.approveCommand(id))} onApproveDangerous={id => void act(runtime.approveDangerous(id))} onReject={id => id ? void act(runtime.rejectApproval(id)) : undefined} /></div>
        <Composer running={running} onSend={send} onStop={activeTask ? () => void act(runtime.stopTask(activeTask.id)) : undefined} />
      </>}
      {!snapshot.projects.length && view === 'chat' ? <button className="project-shortcut" onClick={() => void addProject()}><PlusIcon size={15} />添加项目</button> : null}
    </main>
    <Inspector open={inspectorOpen} task={activeTask} onClose={() => setInspectorOpen(false)} />
  </div>;
}
