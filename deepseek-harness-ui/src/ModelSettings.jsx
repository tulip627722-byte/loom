import {useEffect,useMemo,useState} from 'react';
import {CheckCircle,Key,Plus,Trash,ArrowClockwise,CloudArrowDown} from '@phosphor-icons/react';
import {harness} from './harnessClient.js';
import './model-settings.css';

const getPath=(value,path=[])=>path.reduce((current,key)=>current?.[key],value);
const credentialRef=provider=>`${provider.toUpperCase().replace(/[^A-Z0-9_]/g,'_')}_API_KEY`;
const validKey=value=>{
  const key=value.trim();
  if(!key)return '';
  if(!/^[\x21-\x7E]+$/.test(key)||/^[A-Za-z_][A-Za-z0-9_]*=/.test(key)||(/^(['"]).*\1$/).test(key))throw Error('请只粘贴 API Key，不要包含变量名、引号或空格');
  return key;
};

async function loadSnapshot() {
  const [directory,catalog,settings]=await Promise.all([harness.providerDirectory(),harness.modelCatalog(),harness.settings()]);
  const namespaces=new Map(settings.namespaces.map(item=>[item.ns,item]));
  const rows=directory.providers.map(provider=>{
    const namespace=namespaces.get(provider.settingsNs),profile=getPath(namespace?.value,provider.settingsPath)||{};
    return {...provider,namespace,profile,credentialRef:profile.apiKeyEnv||null};
  });
  const refs=[...new Set(rows.map(row=>row.credentialRef).filter(Boolean))];
  const credentials=refs.length?(await harness.credentialStatus(refs)).credentials:{};
  const activeModels=new Set(catalog.groups.filter(group=>group.models?.length).map(group=>group.id));
  const ready=rows.some(row=>activeModels.has(row.provider)&&(!row.credentialRef||credentials[row.credentialRef]?.configured));
  return {directory:rows,catalog,settings,namespaces,credentials,ready};
}

export async function modelReadiness(){return loadSnapshot();}

export function ModelSettings({firstRun=false,onReady,onChanged}) {
  const [snapshot,setSnapshot]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[keys,setKeys]=useState({}),[adding,setAdding]=useState(false);
  const [custom,setCustom]=useState({provider:'',displayName:'',baseURL:'',api:'openai-completions',model:'',modelName:'',apiKey:''});
  const [discovered,setDiscovered]=useState([]);
  const reload=async()=>{setError('');const next=await loadSnapshot();setSnapshot(next);onReady?.(next.ready);return next;};
  useEffect(()=>{reload().catch(e=>setError(e.message));},[]);
  const visible=useMemo(()=>snapshot?.directory.filter(row=>row.active||row.declared||row.provider==='deepseek-official')||[],[snapshot]);
  const defaultNs=snapshot?.namespaces.get('agent-default-model'),piNs=snapshot?.namespaces.get('llm-pi-ai');
  const currentDefault=defaultNs?.value?.provider&&defaultNs?.value?.model?`${defaultNs.value.provider}::${defaultNs.value.model}`:'';
  async function run(id,fn){setBusy(id);setError('');setNotice('');try{await fn();await reload();onChanged?.();}catch(e){setError(e.message);}finally{setBusy('');}}
  async function saveKey(row){
    const value=validKey(keys[row.provider]||'');if(!value)throw Error('请输入 API Key');let ref=row.credentialRef;
    if(!ref){ref=credentialRef(row.provider);await harness.mutateSettings({ns:row.settingsNs,ops:[{op:'set',path:[...row.settingsPath,'apiKeyEnv'],value:ref}],expectedRevision:row.namespace.revision});}
    await harness.setCredential(ref,value);setKeys(previous=>({...previous,[row.provider]:''}));setNotice(`${row.displayName} 已连接，密钥不会显示或进入迁移包。`);
  }
  async function removeProvider(row){
    if(!confirm(`移除 ${row.displayName}？现有会话仍保留，但新会话不能再使用它。`))return;
    const credential=row.credentialRef&&snapshot.credentials[row.credentialRef];
    if(row.credentialRef===credentialRef(row.provider)&&credential?.configured&&credential.writable)await harness.unsetCredential(row.credentialRef);
    await harness.mutateSettings({ns:row.settingsNs,ops:[{op:'unset',path:row.settingsPath}],expectedRevision:row.namespace.revision});
  }
  async function saveDefault(event){
    const [provider,model]=event.target.value.split('::');
    await run('default',()=>harness.mutateSettings({ns:'agent-default-model',ops:[{op:'set',path:['provider'],value:provider},{op:'set',path:['model'],value:model},{op:'unset',path:['reasoningEffort']}],expectedRevision:defaultNs.revision}));
  }
  async function discover(){
    const provider=custom.provider.trim();if(!provider||!custom.baseURL.trim())throw Error('先填写 Provider ID 和接口地址');
    const value=validKey(custom.apiKey||'');const result=await harness.discoverModels({settingsNs:'llm-pi-ai',provider,baseURL:custom.baseURL.trim(),api:custom.api,...(value?{apiKey:value}:{})});
    setDiscovered(result.models||[]);if(result.models?.length&&!custom.model)setCustom(previous=>({...previous,model:result.models[0].id,modelName:result.models[0].name||''}));
  }
  async function createProvider(){
    const provider=custom.provider.trim(),baseURL=custom.baseURL.trim(),model=custom.model.trim(),key=validKey(custom.apiKey||'');
    if(!/^[a-z][a-z0-9_-]*$/.test(provider))throw Error('Provider ID 需以小写字母开头，只能包含小写字母、数字、下划线和短横线');
    if(snapshot.directory.some(row=>row.provider===provider&&row.declared))throw Error('这个 Provider ID 已存在');
    if(!/^https?:\/\//.test(baseURL)||!model)throw Error('请填写有效接口地址和至少一个模型 ID');
    const ref=credentialRef(provider),profile={displayName:custom.displayName.trim()||provider,baseURL,api:custom.api,models:[{id:model,...(custom.modelName.trim()?{name:custom.modelName.trim()}:{})}],...(key?{apiKeyEnv:ref}:{})};
    const updated=await harness.mutateSettings({ns:'llm-pi-ai',ops:[{op:'set',path:['providers',provider],value:profile}],expectedRevision:piNs.revision});
    if(key)await harness.setCredential(ref,key);
    setCustom({provider:'',displayName:'',baseURL:'',api:'openai-completions',model:'',modelName:'',apiKey:''});setDiscovered([]);setAdding(false);setNotice(`${profile.displayName} 已添加。`);return updated;
  }
  if(!snapshot)return <div className="tu-model-loading"><ArrowClockwise className="is-spinning"/>正在读取 Harness 模型配置…{error&&<p role="alert">{error}</p>}</div>;
  return <div className="tu-model-settings">
    <div className="tu-model-hero"><span className="tu-model-icon"><Key size={20}/></span><div><strong>{firstRun?'连接模型，开始使用':'模型与 API'}</strong><p>{firstRun?'推荐先连接 DeepSeek，也可以添加其他 OpenAI-compatible 服务。':'密钥由 DeepSeek Harness 安全保存；工作台只能看到配置状态。'}</p></div></div>
    {error&&<p className="tu-model-alert is-error" role="alert">{error}</p>}{notice&&<p className="tu-model-alert" role="status">{notice}</p>}
    {snapshot.catalog.groups.length>0&&<label className="tu-model-default"><span>新会话默认模型<small>当前会话仍可在输入框下方单独切换</small></span><select value={currentDefault} onChange={saveDefault} disabled={busy==='default'}>{snapshot.catalog.groups.flatMap(group=>group.models.map(model=><option key={`${group.id}::${model.id}`} value={`${group.id}::${model.id}`}>{group.name} · {model.name||model.id}</option>))}</select></label>}
    <div className="tu-provider-list">{visible.map(row=>{const credential=row.credentialRef?snapshot.credentials[row.credentialRef]:null;return <section className="tu-provider-card" key={row.provider}>
      <header><span><i className={credential?.configured||(!row.credentialRef&&row.active)?'is-ready':''}/><strong>{row.displayName}</strong><small>{row.provider==='deepseek-official'?'官方 DeepSeek':row.provider}</small></span>{row.declared&&row.settingsPath.length>0&&<button aria-label={`移除 ${row.displayName}`} disabled={!!busy} onClick={()=>run(`remove-${row.provider}`,()=>removeProvider(row))}><Trash size={15}/></button>}</header>
      <div className="tu-provider-status">{credential?.configured?<><CheckCircle size={14}/>API Key 已配置{credential.source==='env'?'（环境变量）':''}</>:!row.credentialRef&&row.active?'使用 Provider 原生认证':'尚未配置 API Key'}</div>
      <div className="tu-provider-key"><input type="password" autoComplete="new-password" aria-label={`${row.displayName} API Key`} placeholder={credential?.configured?'输入新 Key 可替换；留空保持原值':'粘贴 API Key'} value={keys[row.provider]||''} onChange={event=>setKeys(previous=>({...previous,[row.provider]:event.target.value}))}/><button disabled={!!busy||!(keys[row.provider]||'').trim()} onClick={()=>run(`key-${row.provider}`,()=>saveKey(row))}>{busy===`key-${row.provider}`?'保存中…':credential?.configured?'更新':'连接'}</button></div>
    </section>})}</div>
    <button className="tu-add-provider" onClick={()=>setAdding(value=>!value)}><Plus size={15}/>{adding?'收起添加面板':'添加 OpenAI-compatible Provider'}</button>
    {adding&&<section className="tu-custom-provider"><div className="tu-custom-grid"><label>Provider ID<input placeholder="my-provider" value={custom.provider} onChange={e=>setCustom(v=>({...v,provider:e.target.value.toLowerCase()}))}/></label><label>显示名称<input placeholder="My Provider" value={custom.displayName} onChange={e=>setCustom(v=>({...v,displayName:e.target.value}))}/></label><label className="is-wide">接口地址<input placeholder="https://api.example.com/v1" value={custom.baseURL} onChange={e=>setCustom(v=>({...v,baseURL:e.target.value}))}/></label><label>API 协议<select value={custom.api} onChange={e=>setCustom(v=>({...v,api:e.target.value}))}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label>API Key<input type="password" autoComplete="new-password" placeholder="仅写入 Harness" value={custom.apiKey} onChange={e=>setCustom(v=>({...v,apiKey:e.target.value}))}/></label><label>模型 ID<input list="discovered-models" placeholder="model-id" value={custom.model} onChange={e=>setCustom(v=>({...v,model:e.target.value}))}/></label><label>模型名称<input placeholder="可选" value={custom.modelName} onChange={e=>setCustom(v=>({...v,modelName:e.target.value}))}/></label></div><datalist id="discovered-models">{discovered.map(model=><option key={model.id} value={model.id}>{model.name}</option>)}</datalist><div className="tu-custom-actions"><button onClick={()=>run('discover',discover)} disabled={!!busy}><CloudArrowDown size={15}/>{busy==='discover'?'读取中…':'获取可用模型'}</button><button className="is-primary" onClick={()=>run('create',createProvider)} disabled={!!busy}>{busy==='create'?'添加中…':'添加并连接'}</button></div><small>若接口不支持模型发现，可以直接填写模型 ID。API Key 留空时保留 Provider 自己的认证方式。</small></section>}
  </div>;
}
