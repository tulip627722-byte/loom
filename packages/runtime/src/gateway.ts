import type { ModelRef } from '@loom/shared';

export interface GatewayStatus {
  online: boolean;
  baseUrl: string;
  error?: string;
  checkedAt: string;
}

export class CcSwitchGateway {
  readonly baseUrl: string;

  constructor(baseUrl = process.env.CC_SWITCH_BASE_URL || 'http://127.0.0.1:15721') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async status(): Promise<GatewayStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { online: true, baseUrl: this.baseUrl, checkedAt };
    } catch (error) {
      return { online: false, baseUrl: this.baseUrl, error: error instanceof Error ? error.message : String(error), checkedAt };
    }
  }

  async models(): Promise<ModelRef[]> {
    const response = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`CC Switch 模型发现失败：HTTP ${response.status}`);
    const payload = await response.json() as { data?: Array<{ id?: string; name?: string; context_window?: number }> };
    return (payload.data || []).flatMap(item => {
      if (!item.id) return [];
      return [{
        providerId: 'cc-switch',
        modelId: item.id,
        displayName: item.name || item.id,
        protocol: 'openai-responses' as const,
        baseUrl: this.baseUrl,
        capabilities: { tools: true, images: true, streaming: true, contextWindow: item.context_window },
      }];
    });
  }
}
