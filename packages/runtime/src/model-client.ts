import type { ModelRef } from '@loom/shared';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelResult {
  id?: string;
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class ModelClient {
  private readonly secrets = new Map<string, string>();

  setCredential(reference: string, secret: string): void {
    if (!reference.trim() || !secret.trim()) throw new Error('凭证引用或密钥无效');
    this.secrets.set(reference, secret);
  }

  async generate(input: {
    model: ModelRef;
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    tools?: ToolDefinition[];
    signal?: AbortSignal;
    onText?: (delta: string) => void;
  }): Promise<ModelResult> {
    if (input.model.protocol === 'openai-responses') return this.responses(input);
    if (input.model.protocol === 'openai-chat') return this.chat(input);
    if (input.model.protocol === 'anthropic-messages') return this.anthropic(input);
    return this.gemini(input);
  }

  private async responses(input: Parameters<ModelClient['generate']>[0]): Promise<ModelResult> {
    const body = {
      model: input.model.modelId,
      instructions: input.system,
      input: input.messages.map(message => ({ role: message.role, content: message.content })),
      tools: input.tools?.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: true })),
      reasoning: input.model.reasoningEffort ? { effort: input.model.reasoningEffort } : undefined,
      stream: true,
      store: false,
    };
    const response = await this.fetchResponse(`${input.model.baseUrl.replace(/\/$/, '')}/v1/responses`, body, input.model, input.signal);
    if (!response.body) throw new Error('模型没有返回流式响应体');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let completed: Record<string, unknown> | undefined;
    const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as Record<string, unknown>;
        if (event.type === 'response.output_text.delta') {
          const delta = String(event.delta || '');
          text += delta;
          input.onText?.(delta);
        }
        if (event.type === 'response.output_item.added') {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call') toolCalls.set(String(item.id || item.call_id), { id: String(item.call_id || item.id), name: String(item.name || ''), arguments: '' });
        }
        if (event.type === 'response.function_call_arguments.delta') {
          const key = String(event.item_id || event.call_id || '');
          const call = toolCalls.get(key);
          if (call) call.arguments += String(event.delta || '');
        }
        if (event.type === 'response.completed') completed = event.response as Record<string, unknown>;
        if (event.type === 'error') throw new Error(String((event.error as Record<string, unknown> | undefined)?.message || '模型流式请求失败'));
      }
    }
    if (!completed) return { text, toolCalls: [...toolCalls.values()].map(call => ({ id: call.id, name: call.name, arguments: this.parseArguments(call.arguments) })) };
    const payload = completed;
    const output = Array.isArray(payload.output) ? payload.output as Array<Record<string, unknown>> : [];
    if (!text) text = output.flatMap(item => item.type === 'message' && Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>).filter(part => part.type === 'output_text').map(part => String(part.text || ''))
      : []).join('');
    const completedCalls = output.filter(item => item.type === 'function_call').map(item => ({
      id: String(item.call_id || item.id || crypto.randomUUID()),
      name: String(item.name || ''),
      arguments: this.parseArguments(item.arguments),
    }));
    const usage = payload.usage as Record<string, unknown> | undefined;
    return {
      id: payload.id ? String(payload.id) : undefined,
      text,
      toolCalls: completedCalls.length ? completedCalls : [...toolCalls.values()].map(call => ({ id: call.id, name: call.name, arguments: this.parseArguments(call.arguments) })),
      usage: usage ? { inputTokens: Number(usage.input_tokens || 0), outputTokens: Number(usage.output_tokens || 0) } : undefined,
    };
  }

  private async chat(input: Parameters<ModelClient['generate']>[0]): Promise<ModelResult> {
    const body = {
      model: input.model.modelId,
      messages: [{ role: 'system', content: input.system }, ...input.messages],
      tools: input.tools?.map(tool => ({ type: 'function', function: tool })),
      stream: false,
    };
    const payload = await this.request(`${input.model.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, body, input.model, input.signal) as Record<string, unknown>;
    const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const toolCalls = (message?.tool_calls as Array<Record<string, unknown>> | undefined || []).map(item => {
      const fn = item.function as Record<string, unknown>;
      return { id: String(item.id || crypto.randomUUID()), name: String(fn.name || ''), arguments: this.parseArguments(fn.arguments) };
    });
    const usage = payload.usage as Record<string, unknown> | undefined;
    return {
      id: payload.id ? String(payload.id) : undefined,
      text: typeof message?.content === 'string' ? message.content : '',
      toolCalls,
      usage: usage ? { inputTokens: Number(usage.prompt_tokens || 0), outputTokens: Number(usage.completion_tokens || 0) } : undefined,
    };
  }

  private async anthropic(input: Parameters<ModelClient['generate']>[0]): Promise<ModelResult> {
    const body = {
      model: input.model.modelId,
      system: input.system,
      max_tokens: 8192,
      messages: input.messages,
      tools: input.tools?.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
    };
    const payload = await this.request(`${input.model.baseUrl.replace(/\/$/, '')}/v1/messages`, body, input.model, input.signal, { 'anthropic-version': '2023-06-01' }) as Record<string, unknown>;
    const content = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : [];
    return {
      id: payload.id ? String(payload.id) : undefined,
      text: content.filter(part => part.type === 'text').map(part => String(part.text || '')).join(''),
      toolCalls: content.filter(part => part.type === 'tool_use').map(part => ({ id: String(part.id || crypto.randomUUID()), name: String(part.name || ''), arguments: this.parseArguments(part.input) })),
      usage: payload.usage ? { inputTokens: Number((payload.usage as Record<string, unknown>).input_tokens || 0), outputTokens: Number((payload.usage as Record<string, unknown>).output_tokens || 0) } : undefined,
    };
  }

  private async gemini(input: Parameters<ModelClient['generate']>[0]): Promise<ModelResult> {
    const secret = input.model.credentialRef ? this.secrets.get(input.model.credentialRef) : undefined;
    if (!secret) throw new Error(`凭证尚未加载：${input.model.credentialRef || input.model.providerId}`);
    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: input.messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
      tools: input.tools?.length ? [{ functionDeclarations: input.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] : undefined,
    };
    const url = `${input.model.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(input.model.modelId)}:generateContent?key=${encodeURIComponent(secret)}`;
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: input.signal || AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status} ${await response.text()}`.slice(0, 1000));
    const payload = await response.json() as Record<string, unknown>;
    const candidate = (payload.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts as Array<Record<string, unknown>> : [];
    const usage = payload.usageMetadata as Record<string, unknown> | undefined;
    return {
      text: parts.map(part => typeof part.text === 'string' ? part.text : '').join(''),
      toolCalls: parts.flatMap(part => {
        const call = part.functionCall as Record<string, unknown> | undefined;
        return call ? [{ id: crypto.randomUUID(), name: String(call.name || ''), arguments: this.parseArguments(call.args) }] : [];
      }),
      usage: usage ? { inputTokens: Number(usage.promptTokenCount || 0), outputTokens: Number(usage.candidatesTokenCount || 0) } : undefined,
    };
  }

  private async request(url: string, body: unknown, model: ModelRef, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    return (await this.fetchResponse(url, body, model, signal, extraHeaders)).json();
  }

  private async fetchResponse(url: string, body: unknown, model: ModelRef, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const secret = model.credentialRef ? this.secrets.get(model.credentialRef) : undefined;
    if (model.providerId !== 'cc-switch' && model.credentialRef && !secret) throw new Error(`凭证尚未加载：${model.credentialRef}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret || 'PROXY_MANAGED'}`, ...(model.protocol === 'anthropic-messages' && secret ? { 'x-api-key': secret } : {}), ...extraHeaders },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status} ${await response.text()}`.slice(0, 1000));
    return response;
  }

  private parseArguments(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    try { return JSON.parse(String(value || '{}')) as Record<string, unknown>; }
    catch { return {}; }
  }
}
