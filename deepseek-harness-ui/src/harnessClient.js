// Loom owns the same-origin facade; Harness stays independently hosted.
const API_ROOT = "/api";

function rpcId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function rpc(method, payload = {}, signal) {
  const id = rpcId();
  const response = await fetch(`${API_ROOT}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-loom-client": "workbench" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: id,
      method,
      payload,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Harness HTTP ${response.status}`);
  }

  const envelope = await response.json();
  if (envelope.type !== "server-response" || envelope.rpcId !== id) {
    throw new Error("Harness 返回了无法识别的响应");
  }
  if (!envelope.result?.ok) {
    const error = new Error(envelope.result?.error?.message || "Harness 请求失败");
    error.code = envelope.result?.error?.code || "internal";
    error.details = envelope.result?.error?.details;
    throw error;
  }
  return envelope.result.value;
}

export const harness = {
  describe: () => rpc("host.describe"),
  pickDirectory: () => rpc("host.pickDirectory"),
  listWorkspaces: () => rpc("workspace.list"),
  createWorkspace: (path) => rpc("workspace.create", { path }),
  listSessions: () => rpc("session.list"),
  createSession: (payload = {}) => rpc("session.create", payload),
  history: (sessionId, maxMessages = 40) => rpc("session.history", { sessionId, maxMessages }),
  models: (sessionId) => rpc("session.models", { sessionId }),
  providerDirectory: () => rpc("llm.providers"),
  modelCatalog: () => rpc("llm.models"),
  discoverModels: (payload) => rpc("llm.discoverModels", payload),
  settings: () => rpc("settings.describe"),
  mutateSettings: (payload) => rpc("settings.mutate", payload),
  credentialStatus: (refs) => rpc("credentials.describe", { refs }),
  setCredential: (ref, value) => rpc("credentials.set", { ref, value }),
  unsetCredential: (ref) => rpc("credentials.unset", { ref }),
  selectModel: (sessionId, selection) => rpc("session.selectModel", { sessionId, ...selection }),
  rename: (sessionId, title) => rpc("session.rename", { sessionId, title }),
  command: (sessionId, line) => rpc("commands/execute", {args:{agentId:sessionId,line}}),
  prompt: (sessionId, text, mode = "queue") => rpc("session.prompt", {
    sessionId,
    mode,
    content: [{ type: "text", text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
  cancel: (sessionId) => rpc("session.cancel", { sessionId }),
  children: (parentSessionId) => rpc("subagent.list", { parentSessionId }),
  childHistory: (parentSessionId, child) => rpc("subagent.history", {parentSessionId,childSessionId:child.id,mode:child.mode,maxMessages:80}),
  interruptChild: (parentSessionId, child) => rpc("subagent.interrupt", {parentSessionId,childSessionId:child.id,mode:child.mode}),
};

export function effectivePlanMode(values = {}) {
  const plan=values?.plan;
  if(!plan)return false;
  return plan.pending?!plan.active:!!plan.active;
}

export function tokenTelemetry(values = {}) {
  const usage=values?.tokenUsage||{};
  const pressure=values?.contextPressure||{};
  const breakdown=values?.contextBreakdown||{};
  const input=(usage.uncachedInputTokens||0)+(usage.cacheReadTokens||0)+(usage.cacheWriteTokens||0);
  const output=usage.outputTokens||0;
  const used=pressure.projectedTokens??pressure.pressureTokens;
  const capacity=pressure.contextWindow;
  return {
    input,output,total:input+output,used,capacity,
    percent:Number.isFinite(used)&&Number.isFinite(capacity)&&capacity>0?Math.min(100,Math.round(used/capacity*100)):null,
    breakdown:{system:breakdown.systemTokens||0,tools:breakdown.toolsTokens||0,messages:breakdown.messageTokens||0},
  };
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

export function conversationFromHistory(entries) {
  const messages = [];
  let partial = "";
  let partialTurn = null;
  let partialStep = null;

  for (const entry of entries || []) {
    const event = entry?.event;
    if (!event) continue;

    if (event.type === "user/message" && event.data?.source?.kind === "user") {
      const text = textFromBlocks(event.data.content);
      if (text) messages.push({ type: "user", text, seq: event.seq });
      continue;
    }

    if (event.type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      if (partialTurn !== event.data?.turn || partialStep !== event.data?.step) {
        partial = "";
        partialTurn = event.data?.turn;
        partialStep = event.data?.step;
      }
      if (chunk?.type === "text-delta") partial += chunk.text || "";
      continue;
    }

    if (event.type === "assistant/message") {
      const text = textFromBlocks(event.data?.message?.content);
      if (text) messages.push({
        type: "assistant",
        text,
        seq: event.seq,
        model: event.data?.message?.source?.model,
      });
      partial = "";
      partialTurn = null;
      partialStep = null;
    }
  }

  if (partial) messages.push({ type: "assistant", text: partial, partial: true });
  return messages;
}

function asPreview(value, max = 400) {
  if (value == null) return "";
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}

function nested(data, ...keys) {
  for (const key of keys) {
    if (data?.[key] != null) return data[key];
  }
  const call = data?.call || data?.toolCall || data?.tool_call || data?.invocation;
  for (const key of keys) {
    if (call?.[key] != null) return call[key];
  }
  return null;
}

// Codex 式线程：把 Harness 事件流折叠成 user / agent / tool / approval 四种行。
// 工具与审批事件的字段在不同 runtime 版本里不完全一致，这里做宽容提取。
export function threadFromHistory(entries) {
  const items = [];
  const toolIndex = new Map();
  let partial = "";
  let partialTurn = null;
  let partialStep = null;

  const flushPartial = () => {
    if (partial) {
      items.push({ kind: "agent", text: partial, partial: true });
      partial = "";
      partialTurn = null;
      partialStep = null;
    }
  };

  for (const entry of entries || []) {
    const event = entry?.event;
    if (!event) continue;
    const type = String(event.type || "");
    const data = event.data || {};
    const seq = event.seq;

    if (type === "user/message" && data?.source?.kind === "user") {
      flushPartial();
      const text = textFromBlocks(data.content);
      if (text) items.push({ kind: "user", text, seq });
      continue;
    }

    if (type === "assistant/chunk") {
      const chunk = data?.chunk;
      if (partialTurn !== data?.turn || partialStep !== data?.step) {
        partial = "";
        partialTurn = data?.turn;
        partialStep = data?.step;
      }
      if (chunk?.type === "text-delta") partial += chunk.text || "";
      continue;
    }

    if (type === "assistant/message") {
      partial = "";
      partialTurn = null;
      partialStep = null;
      const text = textFromBlocks(data?.message?.content);
      if (text) items.push({ kind: "agent", text, seq, model: data?.message?.source?.model });
      continue;
    }

    if (/approval|permission|consent|confirm/i.test(type) && /request|resolve|decision/i.test(type)) {
      const text = nested(data, "message", "prompt", "description", "text") || "Agent 请求执行一个需要你确认的操作";
      const decision = String(data.status || data.decision || data.resolved || "");
      const status = /approv|allow|grant|yes/i.test(decision) ? "approved"
        : /den|reject|no/i.test(decision) ? "rejected" : "pending";
      items.push({ kind: "approval", text: String(text), status, seq });
      continue;
    }

    if (type==='tool/call'||type==='tool/result') {
      const resultBlock=data.message?.content?.find(b=>b.type==='tool-result');
      const id = nested(data, "callId", "call_id", "toolCallId", "id") || resultBlock?.toolCallId || data.message?.source?.callId;
      const isEnd = /end|result|complete|output|response|success|fail|error/i.test(type);
      const rawArgs = nested(data, "arguments", "args", "input", "params", "command");
      const rawResult = resultBlock ? textFromBlocks(resultBlock.content) : nested(data, "result", "output", "response", "error");
      const errored = resultBlock?.isError || /error|fail/i.test(type) || (rawResult && typeof rawResult === "object" && rawResult.error);
      let name = nested(data, "toolName", "tool_name", "name", "tool", "functionName");
      if (!name) name = /shell|command|exec/i.test(type) ? "shell" : "tool";
      const argPreview = asPreview(rawArgs, 120).split("\n")[0];
      const detail = [rawArgs != null ? asPreview(rawArgs) : "", rawResult != null ? `→ ${asPreview(rawResult)}` : ""]
        .filter(Boolean).join("\n");

      if (id != null && toolIndex.has(id)) {
        const target = items[toolIndex.get(id)];
        if (isEnd || rawResult != null) {
          target.status = errored ? "error" : "done";
          if (detail) target.detail = detail;
        }
        continue;
      }

      items.push({
        kind: "tool",
        tool: String(name),
        title: argPreview,
        status: isEnd ? (errored ? "error" : "done") : "running",
        detail: detail || undefined,
        seq,
      });
      if (id != null) toolIndex.set(id, items.length - 1);
    }
  }

  flushPartial();
  return items;
}

export function titleFromSummary(summary) {
  const title = summary?.projections?.values?.title;
  return typeof title === "string" && title.trim() ? title.trim() : "新会话";
}

export function latestSeq(entries) {
  return (entries || []).reduce((max, entry) => Math.max(max, entry?.event?.seq ?? -1), -1);
}

export function hasTurnEndedAfter(entries, seq) {
  return (entries || []).some((entry) => entry?.event?.type === "turn/end" && entry.event.seq > seq);
}
