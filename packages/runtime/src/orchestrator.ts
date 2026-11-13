import type { AgentRole, Approval, Message, ModelRef, Plan, PlanStep, Project, RoleBinding, RuntimeSnapshot, Task, TaskMode } from '@loom/shared';
import { agentRoles } from '@loom/shared';
import type { RuntimeStore, StoredRecord } from './store.ts';
import type { MemoryService } from './memory.ts';
import type { WorkspaceService } from './workspace.ts';
import { ModelClient, type ToolDefinition } from './model-client.ts';
import type { CcSwitchGateway, GatewayStatus } from './gateway.ts';

const plannerPrompt = `你是 Loom Planner。只分析与规划，不执行命令、不修改文件。输出严格 JSON：{"summary":"...","risks":["..."],"acceptance":["..."],"steps":[{"title":"...","objective":"...","role":"executor|ui|research|reviewer","dependsOn":[0],"deliverables":["..."]}]}。步骤最多 6 个，依赖只能引用前面的步骤。`;
const executorPrompt = `你是 Loom Executor，在已批准计划和隔离 Git worktree 内工作。先读取必要文件，再进行最小改动。可用工具必须真实调用；不要声称执行了未调用的操作。命令必须请求 run_command，系统会等待用户批准。完成后简洁总结改动与尚未验证的风险。`;
const uiPrompt = `你是 Loom UI Agent。坚持简洁、克制、可访问的桌面界面：清晰层级、大留白、细边框、低饱和强调色，避免仪表盘式卡片堆叠。使用工具在隔离 worktree 实现已批准任务，完成后说明交互与可访问性。`;
const reviewerPrompt = `你是 Loom Reviewer。只读检查实现，不修改文件。重点检查正确性、回归风险、安全、无障碍、测试与已批准计划的一致性。只报告有证据的问题，并给出验证结论。`;

type TaskRecord = Task & StoredRecord & {
  projectPath?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  prompt?: string;
  resumePlanId?: string | null;
  resumeStepIndex?: number | null;
  roleOverrides?: Partial<Record<AgentRole, ModelRef>>;
};
type RunRecord = StoredRecord & { taskId: string; status: string; stepId?: string; role: AgentRole; error?: string };

export class Orchestrator {
  private readonly listeners = new Set<(event: ReturnType<RuntimeStore['event']>) => void>();
  private readonly modelClient = new ModelClient();
  private gatewayStatus: GatewayStatus;
  private models: ModelRef[] = [];
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: RuntimeStore,
    private readonly memory: MemoryService,
    private readonly workspace: WorkspaceService,
    private readonly gateway: CcSwitchGateway,
  ) {
    this.gatewayStatus = { online: false, baseUrl: gateway.baseUrl, checkedAt: new Date().toISOString() };
  }

  subscribe(listener: (event: ReturnType<RuntimeStore['event']>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): RuntimeSnapshot {
    return {
      projects: this.store.list('projects') as unknown as Project[],
      tasks: this.store.list('tasks') as unknown as Task[],
      messages: this.store.list('messages') as unknown as Message[],
      plans: this.store.list('plans') as unknown as Plan[],
      approvals: this.store.list('approvals') as unknown as Approval[],
      roleBindings: this.bindings(),
      models: this.allModels(),
      gateway: this.gatewayStatus,
      latestEventSequence: this.store.latestSequence(),
    };
  }

  async refreshGateway(): Promise<{ status: GatewayStatus; models: ModelRef[] }> {
    this.gatewayStatus = await this.gateway.status();
    if (this.gatewayStatus.online) {
      try { this.models = await this.gateway.models(); }
      catch (error) { this.gatewayStatus = { ...this.gatewayStatus, error: error instanceof Error ? error.message : String(error) }; }
    } else this.models = [];
    this.emit('gateway.changed', { status: this.gatewayStatus, models: this.models });
    return { status: this.gatewayStatus, models: this.models };
  }

  setCredential(reference: string, secret: string): void {
    this.modelClient.setCredential(reference, secret);
    this.emit('credential.loaded', { reference });
  }

  saveManualModel(model: ModelRef): ModelRef {
    if (!model.modelId.trim() || !/^https?:\/\//.test(model.baseUrl)) throw new Error('模型 ID 或接口地址无效');
    const saved = this.store.put('models', { id: `${model.providerId}:${model.modelId}`, ...model }) as unknown as ModelRef;
    this.models = this.allModels();
    this.emit('models.changed', saved);
    return saved;
  }

  bindRole(binding: RoleBinding): RoleBinding {
    if (!agentRoles.includes(binding.role)) throw new Error('未知 Agent 角色');
    const saved = this.store.put('settings', { id: `role:${binding.role}`, ...binding }) as unknown as RoleBinding;
    this.emit('bindings.changed', saved);
    return saved;
  }

  createProject(input: { title: string; path: string }): Project {
    if (!input.path.trim()) throw new Error('请选择项目目录');
    const project = this.store.put('projects', { title: input.title.trim() || input.path.split(/[\\/]/).at(-1) || '项目', path: input.path });
    this.emit('project.created', project);
    return project as unknown as Project;
  }

  async createTask(input: { projectId?: string; prompt: string; mode: TaskMode; title?: string; roleOverrides?: Partial<Record<AgentRole, ModelRef>> }): Promise<Task> {
    if (!input.prompt.trim()) throw new Error('请输入任务');
    const project = input.projectId ? this.store.get('projects', input.projectId) : undefined;
    const task = this.store.put<TaskRecord>('tasks', {
      projectId: project?.id,
      projectPath: project?.path,
      title: input.title?.trim() || input.prompt.trim().slice(0, 72),
      prompt: input.prompt.trim(),
      mode: input.mode,
      status: input.mode === 'plan' ? 'planning' : 'queued',
      activeRole: input.mode === 'plan' ? 'planner' : this.inferExecutionRole(input.prompt),
      roleOverrides: input.roleOverrides,
    });
    this.addMessage(task.id, 'user', input.prompt);
    this.emit('task.created', task, task.id);
    void (input.mode === 'plan' ? this.plan(task) : this.executeDirect(task));
    return task;
  }

  async approvePlan(planId: string): Promise<Plan> {
    const plan = this.store.get<Plan & StoredRecord>('plans', planId);
    if (!plan || plan.status !== 'pending') throw new Error('方案不存在或已处理');
    const approved = this.store.put<Plan & StoredRecord>('plans', { id: plan.id, status: 'approved' });
    const approval = this.store.list<Approval & StoredRecord>('approvals').find(row => row.kind === 'plan' && row.payload?.planId === planId);
    if (approval) this.store.put('approvals', { id: approval.id, status: 'approved', resolvedAt: new Date().toISOString() });
    this.store.put('tasks', { id: plan.taskId, status: 'queued', activeRole: undefined });
    this.emit('plan.approved', approved, plan.taskId);
    void this.executePlan(approved);
    return approved;
  }

  rejectApproval(id: string): Approval {
    const approval = this.store.get<Approval & StoredRecord>('approvals', id);
    if (!approval || approval.status !== 'pending') throw new Error('审批不存在或已处理');
    const rejected = this.store.put('approvals', { id, status: 'rejected', resolvedAt: new Date().toISOString() }) as unknown as Approval;
    this.store.put('tasks', { id: approval.taskId, status: 'cancelled' });
    this.emit('approval.rejected', rejected, approval.taskId);
    return rejected;
  }

  async approveCommand(id: string): Promise<Approval> {
    const approval = this.store.get<Approval & StoredRecord>('approvals', id);
    if (!approval || approval.kind !== 'command' || approval.status !== 'pending') throw new Error('命令审批不存在或已处理');
    const task = this.store.get<TaskRecord>('tasks', approval.taskId);
    if (!task?.worktreePath) throw new Error('执行工作树不存在');
    const command = String(approval.payload?.command || '');
    const args = Array.isArray(approval.payload?.args) ? approval.payload.args.map(String) : [];
    const result = await this.workspace.runApprovedCommand(task.worktreePath, command, args);
    const approved = this.store.put('approvals', { id, status: 'approved', resolvedAt: new Date().toISOString(), result }) as unknown as Approval;
    this.addMessage(task.id, 'system', `命令 ${command} ${args.join(' ')} 已批准并执行。\n退出码：${result.exitCode}\n${result.stdout}\n${result.stderr}`.slice(0, 12000));
    this.store.put('tasks', { id: task.id, status: 'running' });
    this.emit('approval.approved', approved, task.id);
    const resumePlanId = typeof task.resumePlanId === 'string' ? task.resumePlanId : undefined;
    const resumeStepIndex = Number(task.resumeStepIndex || 0);
    if (resumePlanId) {
      const plan = this.store.get<Plan & StoredRecord>('plans', resumePlanId);
      if (plan) void this.executePlan(plan, resumeStepIndex, `命令已执行，结果：\n${JSON.stringify(result)}`);
    } else void this.runAgent(task, task.activeRole || 'executor', `继续完成任务。此前命令结果：\n${JSON.stringify(result)}`);
    return approved;
  }

  async approveDangerous(id: string): Promise<Approval> {
    const approval = this.store.get<Approval & StoredRecord>('approvals', id);
    if (!approval || approval.kind !== 'dangerous' || approval.status !== 'pending') throw new Error('合并审批不存在或已处理');
    const task = this.store.get<TaskRecord>('tasks', approval.taskId);
    if (!task?.projectPath || typeof task.worktreeBranch !== 'string') throw new Error('任务没有可合并工作树');
    const result = await this.workspace.mergeWorktree(task.projectPath, task.worktreeBranch);
    const approved = this.store.put('approvals', { id, status: 'approved', resolvedAt: new Date().toISOString(), result }) as unknown as Approval;
    this.store.put('tasks', { id: task.id, mergedAt: new Date().toISOString() });
    this.emit('approval.approved', approved, task.id);
    return approved;
  }

  stopTask(id: string): void {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.store.put('tasks', { id, status: 'cancelled' });
    this.emit('task.cancelled', { id }, id);
  }

  private async plan(task: TaskRecord): Promise<void> {
    try {
      const model = this.resolveModel(task, 'planner');
      const memories = this.memory.search(task.prompt || '', task.projectId).map(item => `${item.name}: ${item.content}`).join('\n\n');
      const result = await this.call(task, 'planner', model, plannerPrompt, `${task.prompt}\n\n相关记忆（仅供参考，不代表执行授权）：\n${memories}`);
      const parsed = this.parsePlan(result.text);
      const ids: string[] = parsed.steps.map(() => crypto.randomUUID());
      const steps: PlanStep[] = parsed.steps.map((step, index) => ({
        id: ids[index]!, title: step.title, objective: step.objective, role: step.role,
        dependsOn: step.dependsOn.flatMap(dependency => ids[dependency] ? [ids[dependency]!] : []),
        deliverables: step.deliverables,
      }));
      const plan = this.store.put<Plan & StoredRecord>('plans', { taskId: task.id, summary: parsed.summary, risks: parsed.risks, acceptance: parsed.acceptance, steps, status: 'pending' });
      const approval = this.store.put<Approval & StoredRecord>('approvals', { taskId: task.id, kind: 'plan', title: '确认方案后开始执行', detail: parsed.summary, payload: { planId: plan.id }, status: 'pending' });
      this.store.put('tasks', { id: task.id, status: 'awaiting-plan', activeRole: undefined });
      this.addMessage(task.id, 'assistant', parsed.summary, 'planner');
      this.emit('plan.created', { plan, approval }, task.id);
    } catch (error) { this.fail(task.id, error); }
  }

  private async executeDirect(task: TaskRecord): Promise<void> {
    try {
      const role = this.inferExecutionRole(task.prompt || '');
      await this.prepareWorktree(task);
      await this.runAgent(this.store.get<TaskRecord>('tasks', task.id)!, role, task.prompt || '');
    } catch (error) { this.fail(task.id, error); }
  }

  private async executePlan(plan: Plan & StoredRecord, startIndex = 0, resumeContext?: string): Promise<void> {
    const task = this.store.get<TaskRecord>('tasks', plan.taskId);
    if (!task) return;
    try {
      await this.prepareWorktree(task);
      const refreshed = this.store.get<TaskRecord>('tasks', task.id)!;
      for (let index = startIndex; index < plan.steps.length; index += 1) {
        const step = plan.steps[index]!;
        this.store.put('tasks', { id: task.id, resumePlanId: plan.id, resumeStepIndex: index });
        const run = this.store.put<RunRecord>('runs', { taskId: task.id, stepId: step.id, role: step.role, status: 'running' });
        this.emit('run.started', { run, step }, task.id);
        await this.runAgent(refreshed, step.role, `${resumeContext && index === startIndex ? `${resumeContext}\n\n` : ''}已批准计划：${plan.summary}\n\n当前步骤：${step.title}\n${step.objective}\n交付物：${step.deliverables.join('、')}`, false);
        const currentTask = this.store.get<TaskRecord>('tasks', task.id)!;
        if (currentTask.status === 'awaiting-approval' || currentTask.status === 'failed') return;
        this.store.put('runs', { id: run.id, status: 'completed' });
      }
      const reviewModel = this.tryResolveModel(refreshed, 'reviewer');
      if (reviewModel) await this.runAgent(refreshed, 'reviewer', `检查已批准计划的实现。计划：${plan.summary}`, false);
      const diff = refreshed.worktreePath ? await this.workspace.diff(refreshed.worktreePath) : '';
      this.store.put('tasks', { id: task.id, status: 'completed', activeRole: undefined, diff, resumePlanId: null, resumeStepIndex: null });
      if (task.projectPath && refreshed.worktreeBranch) this.createMergeApproval(task.id, refreshed.worktreeBranch);
      this.emit('task.completed', { taskId: task.id, diff }, task.id);
    } catch (error) { this.fail(task.id, error); }
  }

  private async runAgent(task: TaskRecord, role: AgentRole, prompt: string, finalize = true): Promise<void> {
    const model = this.resolveModel(task, role);
    this.store.put('tasks', { id: task.id, status: 'running', activeRole: role, modelId: model.modelId });
    this.emit('agent.started', { role, model }, task.id);
    const system = role === 'ui' ? uiPrompt : role === 'reviewer' ? reviewerPrompt : executorPrompt;
    const history = this.store.list<Message & StoredRecord>('messages').filter(message => message.taskId === task.id).toReversed().slice(-12).map(message => ({ role: message.role === 'assistant' ? 'assistant' as const : 'user' as const, content: message.content }));
    history.push({ role: 'user', content: prompt });
    const streamingMessage = this.store.put<Message & StoredRecord>('messages', { taskId: task.id, role: 'assistant', agentRole: role, content: '' });
    let streamed = '';
    let lastEmit = 0;
    const result = await this.modelClient.generate({ model, system, messages: history, tools: this.tools(role), signal: this.controller(task.id).signal, onText: delta => {
      streamed += delta;
      const now = Date.now();
      if (now - lastEmit < 80) return;
      lastEmit = now;
      const updated = this.store.put<Message & StoredRecord>('messages', { id: streamingMessage.id, content: streamed });
      this.emit('message.delta', updated, task.id);
    } });
    if (result.text) {
      const completed = this.store.put<Message & StoredRecord>('messages', { id: streamingMessage.id, content: result.text });
      this.emit('message.created', completed, task.id);
    } else this.store.remove('messages', streamingMessage.id);
    const toolResults: string[] = [];
    for (const toolCall of result.toolCalls) {
      const outcome = await this.handleTool(task, role, toolCall.name, toolCall.arguments);
      if (outcome === 'awaiting-approval') return;
      toolResults.push(`工具 ${toolCall.name} 返回：\n${outcome}`);
    }
    if (result.toolCalls.length) return this.runAgent(this.store.get<TaskRecord>('tasks', task.id)!, role, `${toolResults.join('\n\n')}\n\n根据以上真实工具结果继续，完成后给出最终总结。`, finalize);
    if (finalize) {
      const diff = task.worktreePath ? await this.workspace.diff(task.worktreePath) : '';
      this.store.put('tasks', { id: task.id, status: 'completed', activeRole: undefined, diff });
      if (task.projectPath && task.worktreeBranch) this.createMergeApproval(task.id, task.worktreeBranch);
      this.emit('task.completed', { taskId: task.id, diff }, task.id);
    }
  }

  private async handleTool(task: TaskRecord, role: AgentRole, name: string, args: Record<string, unknown>): Promise<string> {
    const root = task.worktreePath || task.projectPath;
    if (!root) return '当前任务没有项目目录';
    if (name === 'list_files') return JSON.stringify(this.workspace.listFiles(root, String(args.directory || '.')));
    if (name === 'read_file') return this.workspace.readFile(root, String(args.path || ''));
    if (name === 'write_file') {
      if (role === 'reviewer' || role === 'research' || role === 'planner') throw new Error(`${role} 没有写文件权限`);
      this.workspace.writeFile(root, String(args.path || ''), String(args.content || ''));
      this.emit('file.written', { path: args.path, role }, task.id);
      return '文件已写入';
    }
    if (name === 'run_command') {
      const approval = this.store.put<Approval & StoredRecord>('approvals', {
        taskId: task.id, kind: 'command', title: `运行 ${String(args.command || '')}`, detail: `${String(args.command || '')} ${(Array.isArray(args.args) ? args.args : []).join(' ')}`,
        payload: { command: args.command, args: Array.isArray(args.args) ? args.args : [] }, status: 'pending',
      });
      this.store.put('tasks', { id: task.id, status: 'awaiting-approval' });
      this.emit('approval.created', approval, task.id);
      return 'awaiting-approval';
    }
    return `未知工具：${name}`;
  }

  private tools(role: AgentRole): ToolDefinition[] {
    const readTools: ToolDefinition[] = [
      { name: 'list_files', description: '列出项目文件', parameters: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'], additionalProperties: false } },
      { name: 'read_file', description: '读取 UTF-8 文本文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
    ];
    if (['planner', 'research', 'reviewer'].includes(role)) return readTools;
    return [...readTools,
      { name: 'write_file', description: '在当前隔离工作树中写入完整文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
      { name: 'run_command', description: '请求用户批准后运行一个命令', parameters: { type: 'object', properties: { command: { type: 'string', enum: ['npm', 'node', 'npx', 'git', 'cargo', 'rustc'] }, args: { type: 'array', items: { type: 'string' } } }, required: ['command', 'args'], additionalProperties: false } },
    ];
  }

  private async prepareWorktree(task: TaskRecord): Promise<void> {
    if (!task.projectPath) return;
    const worktree = await this.workspace.createWorktree(task.projectPath, task.id);
    this.store.put('tasks', { id: task.id, worktreePath: worktree.path, worktreeBranch: worktree.branch });
    this.emit('worktree.created', worktree, task.id);
  }

  private bindings(): RoleBinding[] {
    return agentRoles.map(role => this.store.get<StoredRecord & RoleBinding>('settings', `role:${role}`) || { role });
  }

  private allModels(): ModelRef[] {
    const manual = this.store.list<StoredRecord & ModelRef>('models');
    const map = new Map<string, ModelRef>();
    for (const model of [...this.models, ...manual]) map.set(`${model.providerId}:${model.modelId}`, model);
    return [...map.values()];
  }

  private resolveModel(task: TaskRecord, role: AgentRole): ModelRef {
    const model = this.tryResolveModel(task, role);
    if (!model) throw new Error(`尚未给 ${role} 绑定可用模型，请在设置中完成角色绑定`);
    return model;
  }

  private tryResolveModel(task: TaskRecord, role: AgentRole): ModelRef | undefined {
    const override = (task as TaskRecord & { roleOverrides?: Partial<Record<AgentRole, ModelRef>> }).roleOverrides?.[role];
    if (override) return override;
    return this.bindings().find(binding => binding.role === role)?.model;
  }

  private inferExecutionRole(prompt: string): AgentRole {
    return /界面|ui|页面|前端|样式|交互|react|css/i.test(prompt) ? 'ui' : 'executor';
  }

  private parsePlan(text: string): { summary: string; risks: string[]; acceptance: string[]; steps: Array<{ title: string; objective: string; role: Exclude<AgentRole, 'planner'>; dependsOn: number[]; deliverables: string[] }> } {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps.slice(0, 6) as Array<Record<string, unknown>> : [];
    if (!rawSteps.length) throw new Error('Planner 没有返回可执行步骤');
    return {
      summary: String(parsed.summary || '').slice(0, 4000),
      risks: (Array.isArray(parsed.risks) ? parsed.risks : []).map(String).slice(0, 8),
      acceptance: (Array.isArray(parsed.acceptance) ? parsed.acceptance : []).map(String).slice(0, 8),
      steps: rawSteps.map((step, index) => ({
        title: String(step.title || `步骤 ${index + 1}`).slice(0, 160),
        objective: String(step.objective || '').slice(0, 4000),
        role: ['executor', 'ui', 'research', 'reviewer'].includes(String(step.role)) ? step.role as Exclude<AgentRole, 'planner'> : 'executor',
        dependsOn: (Array.isArray(step.dependsOn) ? step.dependsOn : []).map(Number).filter(value => Number.isInteger(value) && value >= 0 && value < index),
        deliverables: (Array.isArray(step.deliverables) ? step.deliverables : []).map(String).slice(0, 8),
      })),
    };
  }

  private async call(task: TaskRecord, role: AgentRole, model: ModelRef, system: string, prompt: string) {
    this.store.put('tasks', { id: task.id, status: role === 'planner' ? 'planning' : 'running', activeRole: role, modelId: model.modelId });
    this.emit('agent.started', { role, model }, task.id);
    return this.modelClient.generate({ model, system, messages: [{ role: 'user', content: prompt }], signal: this.controller(task.id).signal });
  }

  private controller(taskId: string): AbortController {
    const existing = this.controllers.get(taskId);
    if (existing && !existing.signal.aborted) return existing;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    return controller;
  }

  private addMessage(taskId: string, role: Message['role'], content: string, agentRole?: AgentRole): Message {
    const message = this.store.put('messages', { taskId, role, agentRole, content }) as unknown as Message;
    this.emit('message.created', message, taskId);
    return message;
  }

  private fail(taskId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.put('tasks', { id: taskId, status: 'failed', error: message, activeRole: undefined });
    this.addMessage(taskId, 'system', message);
    this.emit('task.failed', { error: message }, taskId);
  }

  private createMergeApproval(taskId: string, branch: string): void {
    const existing = this.store.list<Approval & StoredRecord>('approvals').some(item => item.taskId === taskId && item.kind === 'dangerous' && item.payload?.action === 'merge');
    if (existing) return;
    const approval = this.store.put<Approval & StoredRecord>('approvals', { taskId, kind: 'dangerous', title: '合并改动到源项目', detail: `将 ${branch} 合并到源项目当前分支。源项目存在未提交改动时会拒绝执行。`, payload: { action: 'merge', branch }, status: 'pending' });
    this.emit('approval.created', approval, taskId);
  }

  private emit(type: string, data: unknown, taskId?: string): void {
    const event = this.store.event(type, data, taskId);
    for (const listener of this.listeners) listener(event);
  }
}
