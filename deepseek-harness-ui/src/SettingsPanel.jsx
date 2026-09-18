import {useState} from 'react';
import {DownloadSimple as ArrowDownTray,UploadSimple as ArrowUpTray,FileText,CaretRight,ShieldCheck,Cpu} from '@phosphor-icons/react';
import './settings.css';

export function SettingsPanel({model,state,onMemory,onModels,onImport}) {
  const [importing,setImporting]=useState(false),[feedback,setFeedback]=useState(null);
  const platform={darwin:'macOS',win32:'Windows',linux:'Linux'}[state.platform]||'读取中';
  const rawModel=String(model||'').split('::').at(-1);const modelName={'deepseek-v4-flash':'DeepSeek V4 Flash','deepseek-v4-pro':'DeepSeek V4 Pro'}[rawModel]||rawModel||'未连接';
  async function importFile(event) {
    const file=event.target.files?.[0];if(!file)return;
    setImporting(true);setFeedback(null);
    try {const result=await onImport(JSON.parse(await file.text()));setFeedback({ok:true,text:result.notes||'导入完成，请检查项目与安排。'});}
    catch(error){setFeedback({ok:false,text:error.message||'导入失败，请检查文件格式。'});}
    finally{setImporting(false);event.target.value='';}
  }
  return <div className="tu-settings">
    <p className="tu-settings-intro">你的工作伙伴，和保存在这台电脑上的工作资料。</p>
    <section aria-labelledby="settings-workspace">
      <h3 id="settings-workspace">工作台</h3>
      <div className="tu-settings-group">
        <div className="tu-setting-row"><span>当前模型</span><div className="tu-setting-value"><strong>{modelName}</strong><span className={`tu-connection-tag ${state.connected?'is-online':''}`}>{state.connected?'已连接':'连接中'}</span></div></div>
        <button className="tu-setting-row tu-setting-link" onClick={onModels}><span className="tu-setting-label"><Cpu size={18}/><span>模型与 API<small>连接 DeepSeek 或其他兼容模型</small></span></span><CaretRight size={15}/></button>
        <div className="tu-setting-row"><span>运行环境</span><span className="tu-setting-value">{platform}<small>本地运行</small></span></div>
      </div>
    </section>
    <section aria-labelledby="settings-local">
      <h3 id="settings-local">记忆与存储</h3>
      <div className="tu-settings-group">
        <button className="tu-setting-row tu-setting-link" onClick={onMemory}><span className="tu-setting-label"><FileText size={18}/><span>个人记忆<small>查看和编辑 Tulip 对你的了解</small></span></span><CaretRight size={15}/></button>
        <div className="tu-setting-row tu-setting-path"><span>数据文件夹</span><code>{state.dataRoot||'读取中…'}</code></div>
      </div>
    </section>
    <section aria-labelledby="settings-migrate">
      <h3 id="settings-migrate">备份与迁移</h3>
      <div className="tu-settings-group tu-migration-group">
        <p>换一台电脑，也能带上你的工作资料。</p>
        <div className="tu-migration-actions">
          <a href="/tulip/export" download className="tu-settings-action"><ArrowDownTray size={17}/>导出备份</a>
          <label className={`tu-settings-action tu-import-action ${importing?'is-busy':''}`}><ArrowUpTray size={17}/>{importing?'正在导入…':'导入备份'}<input aria-label="导入备份" type="file" accept="application/json,.json" disabled={importing} onChange={importFile}/></label>
        </div>
        <div className="tu-security-note"><ShieldCheck size={15}/><span>不包含 API 密钥和登录凭证</span></div>
        <details><summary>迁移包含什么？</summary><p>包含记忆、Skills、方案、待办、安排和产出索引。原始 Harness 对话不在迁移包中，仍保留在旧设备。</p><p>导入后需要重新绑定项目文件夹，并检查、启用安排。文档中自行填写的敏感内容，请在分享备份前检查。</p><p>Windows 兼容性尚待真机验证。</p></details>
        {feedback&&<p className={`tu-import-feedback ${feedback.ok?'is-success':'is-error'}`} role={feedback.ok?'status':'alert'}>{feedback.text}</p>}
      </div>
    </section>
    <footer>Tulip · 个人工作台</footer>
  </div>;
}
