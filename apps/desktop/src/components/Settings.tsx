import { ArrowClockwiseIcon } from '@phosphor-icons/react/ArrowClockwise';
import { CheckCircleIcon } from '@phosphor-icons/react/CheckCircle';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import { useState } from 'react';
import type { AgentRole, ModelRef, ModelProtocol, RoleBinding, RuntimeSnapshot } from '@loom/shared';
import { agentRoles } from '@loom/shared';

interface SettingsProps { snapshot: RuntimeSnapshot; onRefresh(): void; onBind(binding: RoleBinding): void; onAddModel(model: ModelRef, secret: string): void }
const names: Record<AgentRole, string> = { planner: '计划', executor: '执行', ui: '界面', research: '研究', reviewer: '评审' };

export function Settings({ snapshot, onRefresh, onBind, onAddModel }: SettingsProps) {
  const [manual, setManual] = useState({ providerId: 'direct', modelId: '', displayName: '', baseUrl: '', protocol: 'openai-responses' as ModelProtocol, secret: '' });
  const bindingMap = new Map(snapshot.roleBindings.map(binding => [binding.role, binding]));
  const models = snapshot.models;
  return <div className="settings-page page-scroll">
    <header className="page-title"><div><span className="eyebrow">SETTINGS</span><h1>模型与角色</h1><p>每个 Agent 使用独立模型。任务内还可以临时覆盖。</p></div></header>
    <section className="settings-section gateway-row">
      <div className="gateway-status">{snapshot.gateway.online ? <CheckCircleIcon weight="fill" className="ok" size={20} /> : <WarningCircleIcon weight="fill" className="warn" size={20} />}<div><strong>CC Switch</strong><span>{snapshot.gateway.online ? `${models.length} 个可用模型` : '当前离线，可稍后重试或添加直连 Provider'}</span></div></div>
      <button className="secondary" onClick={onRefresh}><ArrowClockwiseIcon size={16} />重新探测</button>
    </section>
    <section className="settings-section role-matrix">
      <header><div><h2>角色默认模型</h2><p>优先级：全局默认 → 项目覆盖 → 单任务覆盖</p></div></header>
      {agentRoles.map(role => {
        const current = bindingMap.get(role)?.model;
        return <label key={role}><span><strong>{names[role]}</strong><small>{role}</small></span><select value={current ? `${current.providerId}:${current.modelId}` : ''} onChange={event => { const model = models.find(item => `${item.providerId}:${item.modelId}` === event.target.value); onBind({ role, model }); }}><option value="">未绑定</option>{models.map((model: ModelRef) => <option key={`${model.providerId}:${model.modelId}`} value={`${model.providerId}:${model.modelId}`}>{model.displayName}</option>)}</select></label>;
      })}
    </section>
    <section className="settings-section manual-model">
      <header><div><h2>添加直连模型</h2><p>凭证由 Windows Credential Manager 保存；这里仅登记模型和接口地址。</p></div></header>
      <div className="manual-grid"><label>Provider ID<input value={manual.providerId} onChange={event => setManual(value => ({ ...value, providerId: event.target.value }))} /></label><label>模型 ID<input value={manual.modelId} onChange={event => setManual(value => ({ ...value, modelId: event.target.value }))} /></label><label className="wide">接口地址<input placeholder="https://api.example.com" value={manual.baseUrl} onChange={event => setManual(value => ({ ...value, baseUrl: event.target.value }))} /></label><label>显示名称<input value={manual.displayName} onChange={event => setManual(value => ({ ...value, displayName: event.target.value }))} /></label><label>协议<select value={manual.protocol} onChange={event => setManual(value => ({ ...value, protocol: event.target.value as ModelProtocol }))}><option value="openai-responses">OpenAI Responses</option><option value="openai-chat">OpenAI Chat</option><option value="anthropic-messages">Anthropic Messages</option><option value="gemini">Gemini</option></select></label><label className="wide">API Key<input type="password" autoComplete="new-password" value={manual.secret} onChange={event => setManual(value => ({ ...value, secret: event.target.value }))} /></label></div>
      <footer><button className="primary" disabled={!manual.modelId.trim() || !manual.baseUrl.trim() || !manual.secret.trim()} onClick={() => { const credentialRef = `provider:${manual.providerId}`; onAddModel({ providerId: manual.providerId, modelId: manual.modelId, displayName: manual.displayName || manual.modelId, baseUrl: manual.baseUrl, protocol: manual.protocol, credentialRef, capabilities: { tools: true, images: false, streaming: true } }, manual.secret); }}>添加模型</button></footer>
    </section>
  </div>;
}
