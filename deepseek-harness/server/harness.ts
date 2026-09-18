import { randomUUID } from 'node:crypto';
export type Frame = { rpcId: string; payload: any; [key: string]: any };
export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export function endStatus(reason: any): RunStatus {
  if (reason?.kind === 'completed') return 'completed';
  if (reason?.kind === 'aborted') return 'stopped';
  if (reason?.kind === 'interrupted') return 'interrupted';
  return 'failed';
}
export class Harness {
  url: string;
  pending = new Map<string, Frame>();
  connected = false;
  controller?: AbortController;
  constructor(url: string) { this.url = url.replace(/\/$/, ''); }
  async rpc(method: string, payload: any = {}, signal?: AbortSignal): Promise<any> {
    const rpcId = randomUUID();
    const res = await fetch(`${this.url}/api/${method}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'client-request',rpcId,method,payload}), signal: signal || AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Harness HTTP ${res.status}`);
    const body = await res.json() as any;
    if (body.rpcId !== rpcId || !body.result?.ok) throw new Error(body.result?.error?.message || 'Harness 响应无效');
    return body.result.value;
  }
  async respond(rpcId: string, value: any) {
    if (!this.pending.has(rpcId)) throw new Error('问题已失效，请刷新状态');
    const res = await fetch(`${this.url}/api/respond`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-response',rpcId,result:{ok:true,value}}),signal:AbortSignal.timeout(15000)});
    const answer = await res.json() as any;
    if (!answer.accepted) throw new Error(`回答未被接受：${answer.reason || '已失效'}`);
    this.pending.delete(rpcId); return answer;
  }
  async consume(onFrame: (frame: Frame) => void) {
    this.controller = new AbortController();
    while (!this.controller.signal.aborted) {
      try {
        await new Promise<void>((resolve,reject)=>{
          const url=new URL('/api/events.mux',this.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';
          const socket=new WebSocket(url);const signal=this.controller!.signal;
          const abort=()=>socket.close();signal.addEventListener('abort',abort,{once:true});
          socket.addEventListener('open',()=>{
            this.pending.clear();this.connected=true;
            onFrame({rpcId:'connection',payload:{type:'connection',connected:true}});
          });
          socket.addEventListener('message',event=>{try {
            const frame=JSON.parse(String(event.data)) as Frame; const p=frame.payload;
            if(!p)return;
            if(p.type==='stream/error')throw Error(p.error?.message||'Harness 事件错误');
            if (p.type === 'question/requested' || p.type === 'approval/requested') this.pending.set(frame.rpcId,frame);
            if (p.type === 'question/resolved') this.pending.delete(p.questionRpcId);
            if (p.type === 'approval/resolved') for (const [id,f] of this.pending) if(f.payload.approvalId === p.approvalId) this.pending.delete(id);
            onFrame(frame);
          }catch(e){socket.close();reject(e);}});
          socket.addEventListener('error',()=>{socket.close();reject(Error('Harness WebSocket 连接失败'));});
          socket.addEventListener('close',()=>{signal.removeEventListener('abort',abort);resolve();},{once:true});
          if(signal.aborted)abort();
        });
      } catch (e) { if (!this.controller.signal.aborted) onFrame({rpcId:'connection',payload:{type:'connection',connected:false,error:String(e)}}); }
      this.connected = false; this.pending.clear();
      if (!this.controller.signal.aborted) await new Promise(resolve=>setTimeout(resolve,1500));
    }
  }
  stop() { this.controller?.abort(); }
}
