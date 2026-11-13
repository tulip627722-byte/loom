export const agentRoles = ['planner', 'executor', 'ui', 'research', 'reviewer'] as const;
export type AgentRole = typeof agentRoles[number];

export type ModelProtocol = 'openai-responses' | 'openai-chat' | 'anthropic-messages' | 'gemini';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelRef {
  providerId: string;
  modelId: string;
  displayName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  credentialRef?: string;
  reasoningEffort?: ReasoningEffort;
  capabilities: {
    tools: boolean;
    images: boolean;
    streaming: boolean;
    contextWindow?: number;
  };
}

export interface RoleBinding {
  role: AgentRole;
  model?: ModelRef;
  fallback?: ModelRef;
}

export type TaskMode = 'plan' | 'direct';
export type TaskStatus = 'idle' | 'planning' | 'awaiting-plan' | 'queued' | 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'cancelled';

export interface Project {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId?: string;
  title: string;
  mode: TaskMode;
  status: TaskStatus;
  activeRole?: AgentRole;
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  agentRole?: AgentRole;
  content: string;
  createdAt: string;
}

export interface PlanStep {
  id: string;
  title: string;
  objective: string;
  role: Exclude<AgentRole, 'planner'>;
  dependsOn: string[];
  deliverables: string[];
}

export interface Plan {
  id: string;
  taskId: string;
  summary: string;
  risks: string[];
  acceptance: string[];
  steps: PlanStep[];
  status: 'pending' | 'approved' | 'revision-requested' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  taskId: string;
  runId?: string;
  kind: 'plan' | 'command' | 'external-write' | 'dangerous';
  title: string;
  detail: string;
  payload?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
}

export interface RuntimeEvent {
  seq: number;
  type: string;
  taskId?: string;
  data: unknown;
  createdAt: string;
}

export interface RuntimeSnapshot {
  projects: Project[];
  tasks: Task[];
  messages: Message[];
  plans: Plan[];
  approvals: Approval[];
  roleBindings: RoleBinding[];
  models: ModelRef[];
  gateway: { online: boolean; baseUrl: string; error?: string; checkedAt?: string };
  latestEventSequence: number;
}
