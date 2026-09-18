export async function local(path, data) {
  const response = await fetch(`/tulip/${path}`, {method:data===undefined?'GET':'POST',headers:{'content-type':'application/json','x-tulip-client':'workbench'},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const result=await response.json();if(!response.ok)throw Error(result.error||`请求失败 ${response.status}`);return result;
}
export function watch(onEvent,onReady) {
  const source=new EventSource('/tulip/events');
  source.onmessage=event=>{const data=JSON.parse(event.data);if(!data.replay)onEvent(data);};
  source.addEventListener('ready',event=>onReady(JSON.parse(event.data)));
  source.onerror=()=>onReady({connected:false});return ()=>source.close();
}
export const statusLabels={queued:'排队中',running:'执行中',waiting:'等你回答',settling:'等待协作收尾',completed:'执行结束',failed:'失败',blocked:'依赖未完成',stopped:'已停止',stopping:'正在停止',interrupted:'已中断',scheduled:'等待调度',preparing:'准备中'};
