import {Children,useEffect,useId,useMemo,useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {ArrowClockwise,ArrowSquareOut,Check,Copy,FileCode,Globe,PencilSimple,X} from '@phosphor-icons/react';
import {local} from './loomClient.js';
import {isMindmap,parseMindmap} from './mermaid.js';
import './markdown.css';
import './preview.css';
import './mermaid-preview.css';

export function previewUrl(preview,origin){return preview?.sourceType==='static-html'?`${origin}/preview/${encodeURIComponent(preview.id)}/`:preview?.url||'';}

let mermaidRenderQueue=Promise.resolve(),mermaidInitialized=false,mermaidRenderSequence=0;
async function renderMermaid(chart,id) {
  let complete;
  const result=new Promise((resolve,reject)=>{complete={resolve,reject};});
  mermaidRenderQueue=mermaidRenderQueue.catch(()=>{}).then(async()=>{
    try {
      const mermaid=(await import('mermaid')).default;
      if(!mermaidInitialized){mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',themeVariables:{primaryColor:'#e7f1ff',primaryTextColor:'#31587f',primaryBorderColor:'#9ab9dc',lineColor:'#7294ba',secondaryColor:'#f3f7ff',tertiaryColor:'#eef5ff',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}});mermaidInitialized=true;}
      complete.resolve(await mermaid.render(id,chart));
    }catch(error){complete.reject(error);}
  });
  return result;
}

function MermaidDiagram({chart}) {
  const baseId=`loom-${useId().replace(/[^a-z0-9]/gi,'')}`,[error,setError]=useState(''),[svg,setSvg]=useState(''),[fit,setFit]=useState(true);
  useEffect(()=>{let alive=true;setError('');setSvg('');const id=`${baseId}-${++mermaidRenderSequence}`;
    const timer=setTimeout(()=>renderMermaid(chart,id).then(result=>{if(alive)setSvg(result.svg);}).catch(reason=>{if(alive)setError(reason?.message||'图表语法有误');}),0);
    return()=>{alive=false;clearTimeout(timer);};
  },[chart,baseId]);
  return <div className="tu-mermaid">{error?<div className="tu-mermaid-error"><strong>Mermaid 无法渲染</strong><small>{error}</small><pre>{chart}</pre></div>:svg?<><div className="tu-mermaid-toolbar"><span>思维导图</span><button className={fit?'is-active':''} onClick={()=>setFit(true)}>全图</button><button className={!fit?'is-active':''} onClick={()=>setFit(false)}>清晰</button></div><div className="tu-mermaid-viewport" aria-label="Mermaid 图表"><div className={`tu-mermaid-canvas ${fit?'is-fit':'is-natural'}`} dangerouslySetInnerHTML={{__html:svg}}/></div></>:<div className="tu-mermaid-loading">正在绘制思维导图…</div>}</div>;
}

function MindmapNode({node,depth,openDepth}) {
  if(!node.children.length)return <li className="tu-mindmap-leaf"><span>{node.label}</span></li>;
  return <li><details key={`${node.label}-${openDepth}`} open={depth<openDepth}><summary><span>{node.label}</span><small>{node.children.length}</small></summary><ul>{node.children.map((child,index)=><MindmapNode key={`${child.label}-${index}`} node={child} depth={depth+1} openDepth={openDepth}/>)}</ul></details></li>;
}

function MindmapDiagram({chart}) {
  const [expanded,setExpanded]=useState(false),tree=useMemo(()=>parseMindmap(chart),[chart]);
  return <section className="tu-mindmap" aria-label="Mermaid 思维导图"><header><span><strong>思维导图</strong><small>点击节点展开分支</small></span><button onClick={()=>setExpanded(value=>!value)}>{expanded?'只看主干':'展开全部'}</button></header><div className="tu-mindmap-tree"><ul><MindmapNode key={expanded?'all':'main'} node={tree} depth={0} openDepth={expanded?99:2}/></ul></div></section>;
}

function MarkdownDocument({content}) {
  const first=/```mermaid\s*\r?\n([\s\S]*?)```/i.exec(content),chart=first?.[1]?.replace(/\n$/,'')||'',body=first?`${content.slice(0,first.index)}${content.slice(first.index+first[0].length)}`:content;
  const renderChart=value=>isMindmap(value)?<MindmapDiagram chart={value}/>:<MermaidDiagram chart={value}/>;
  return <article className="tu-document tu-markdown">{chart&&<div className="tu-document-visual"><span>文档中的图</span>{renderChart(chart)}</div>}<Markdown remarkPlugins={[remarkGfm]} components={{pre({children,...props}){const child=Children.toArray(children)[0];if(child?.props?.className==='language-mermaid')return renderChart(String(child.props.children||'').replace(/\n$/,''));return <pre {...props}>{children}</pre>;}}}>{body}</Markdown></article>;
}

export function PreviewPanel({state,task,projectId,selectedId,onSelect,onClose,onRefresh,width,onResize,notify}) {
  const [input,setInput]=useState(''),[frameKey,setFrameKey]=useState(0),[busy,setBusy]=useState(false),[frameReady,setFrameReady]=useState(false);
  const [document,setDocument]=useState(null),[editing,setEditing]=useState(false),[draft,setDraft]=useState(''),[documentError,setDocumentError]=useState('');
  const previews=useMemo(()=>state.previews.filter(preview=>task?(preview.sessionId===task.sessionId||preview.taskId===task.id||preview.parentTaskId===task.id||task.parentTaskId&&preview.parentTaskId===task.parentTaskId):projectId?preview.projectId===projectId:true),[state.previews,task,projectId]);
  const selected=previews.find(preview=>preview.id===selectedId)||previews[0],url=previewUrl(selected,state.previewOrigin),isFile=!!selected?.artifactId,isMarkdown=selected?.sourceType==='markdown';
  useEffect(()=>{if(previews.length&&!previews.some(preview=>preview.id===selectedId))onSelect(previews[0].id);},[previews.map(preview=>preview.id).join(','),selectedId]);
  useEffect(()=>{setFrameReady(false);},[url,frameKey]);
  useEffect(()=>{let alive=true;setEditing(false);setDocument(null);setDocumentError('');if(!selected?.artifactId)return()=>{alive=false;};local(`artifact?id=${encodeURIComponent(selected.artifactId)}`).then(value=>{if(alive){setDocument(value);setDraft(value.content);}}).catch(error=>alive&&setDocumentError(error.message));return()=>{alive=false;};},[selected?.id,selected?.artifactId]);
  async function submit(event){event.preventDefault();if(!input.trim())return;setBusy(true);try{const preview=await local('previews',{sessionId:task?.sessionId,args:{url:input.trim(),projectId,title:input.trim()}});await onRefresh();onSelect(preview.id);setInput('');}catch(error){notify(error.message);}finally{setBusy(false);}}
  function beginResize(event){event.currentTarget.setPointerCapture(event.pointerId);const start=event.clientX,startWidth=width;const move=moveEvent=>onResize(Math.min(760,Math.max(360,startWidth+start-moveEvent.clientX)));const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);}
  async function copy(){const value=isMarkdown?selected.entryPath:url;try{await navigator.clipboard.writeText(value);notify(isMarkdown?'文件路径已复制':'预览地址已复制');}catch{notify('无法复制');}}
  async function reload(){if(isFile){try{const value=await local(`artifact?id=${encodeURIComponent(selected.artifactId)}`);setDocument(value);setDraft(value.content);setDocumentError('');}catch(error){setDocumentError(error.message);}}setFrameKey(value=>value+1);}
  async function save(){if(!document)return;setBusy(true);try{const saved=await local('artifact/save',{id:document.id,content:draft,revision:document.revision});setDocument(saved);setDraft(saved.content);setEditing(false);setFrameKey(value=>value+1);await onRefresh();notify('文件已保存，预览已更新');}catch(error){notify(error.message);}finally{setBusy(false);}}
  const kindLabel=selected?.sourceType==='static-html'?'HTML 页面':isMarkdown?'Markdown · Mermaid':selected?.sourceType==='local-url'?'本地服务':'外部网页';
  return <aside className="wb-panel tu-panel tu-preview-panel" style={{width}}><div className="tu-preview-resizer" role="separator" aria-orientation="vertical" onPointerDown={beginResize}/><header><div><strong>产出预览</strong>{selected&&<small>{kindLabel} · {new Date(selected.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</small>}</div><button aria-label="关闭预览" onClick={onClose}><X size={17}/></button></header>
    <form className="wb-preview-form" onSubmit={submit}><Globe size={15}/><input aria-label="预览地址" value={input} placeholder="输入 localhost 或网页地址" onChange={event=>setInput(event.target.value)}/><button disabled={busy||!input.trim()}>{busy?'…':'打开'}</button></form>
    {previews.length>0&&<><div className="tu-preview-tabs"><select aria-label="选择预览" value={selected?.id||''} onChange={event=>onSelect(event.target.value)}>{previews.map(preview=><option key={preview.id} value={preview.id}>{preview.title}</option>)}</select><button title="刷新" aria-label="刷新预览" onClick={reload}><ArrowClockwise size={15}/></button><button title="复制" aria-label="复制预览地址" onClick={copy}><Copy size={15}/></button>{url&&<button title="在浏览器打开" aria-label="在浏览器打开" onClick={()=>window.open(url,'_blank','noopener,noreferrer')}><ArrowSquareOut size={15}/></button>}</div>{isFile&&<div className="tu-preview-mode"><button className={!editing?'is-active':''} onClick={()=>setEditing(false)}><FileCode size={14}/>预览</button><button className={editing?'is-active':''} onClick={()=>setEditing(true)}><PencilSimple size={14}/>编辑</button><span>{selected.entryPath}</span>{editing&&<button className="tu-save" disabled={busy||!document||draft===document.content} onClick={save}><Check size={14}/>{busy?'保存中…':'保存'}</button>}</div>}</>}
    {selected&&selected.status==='ready'?(editing&&isFile?<div className="tu-source-editor"><textarea aria-label={`编辑 ${selected.title}`} spellCheck={false} value={draft} onChange={event=>setDraft(event.target.value)}/><small>保存会直接修改项目中的 {selected.entryPath}；外部变更会触发冲突提示。</small></div>:isMarkdown?<div className="tu-document-frame">{documentError?<div className="wb-preview-empty"><h3>无法打开文档</h3><p>{documentError}</p></div>:document?<MarkdownDocument content={document.content}/>:<div className="tu-preview-loading">正在读取文档…</div>}</div>:<div className="tu-preview-frame"><div className={`tu-preview-loading ${frameReady?'is-hidden':''}`}>正在打开预览…</div><iframe key={`${selected.id}-${frameKey}`} title={selected.title||'网页预览'} src={url} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin" onLoad={()=>setFrameReady(true)}/>{selected.sourceType==='external-url'&&<p>部分网站会禁止嵌入。如果这里保持空白，请使用右上角“在浏览器打开”。</p>}</div>):<div className="wb-preview-empty"><Globe size={27}/><h3>{selected?'预览暂不可用':'还没有预览产出'}</h3><p>{selected?'项目重新绑定或产出恢复后可继续预览。':'Agent 登记 HTML、Markdown 或网址后会自动在这里打开。'}</p></div>}
  </aside>;
}
