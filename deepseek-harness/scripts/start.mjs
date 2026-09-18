import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { preparePresets } from '../server/presets.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.LOOM_PORT||3080), harnessPort=Number(process.env.LOOM_HARNESS_PORT||3081);
const dshHome=resolve(process.env.DSH_HOME||join(homedir(),'.dsh'));
const dataRoot=resolve(process.env.LOOM_DATA_DIR||join(homedir(),'LoomData'));
const env={...process.env,LOOM_PORT:String(port),LOOM_HARNESS_URL:`http://127.0.0.1:${harnessPort}`,LOOM_SERVICE_URL:`http://127.0.0.1:${port}`,LOOM_BRIDGE_TOKEN:randomUUID(),LOOM_DATA_DIR:dataRoot};
const run=(args,cwd=root)=>spawn(process.execPath,args,{cwd,env,stdio:'inherit'});
const build=run([resolve(root,'../deepseek-harness-ui/node_modules/vite/bin/vite.js'),'build'],resolve(root,'../deepseek-harness-ui'));
const code=await new Promise(resolve=>build.on('exit',resolve));if(code!==0)process.exit(Number(code)||1);
preparePresets(root,dshHome,dataRoot);
const children=[run(['node_modules/@deepseek-ai/dsh/lib/bin.js','web','--host','127.0.0.1','--port',String(harnessPort)]),run(['server/main.ts'])];
let closing=false;
function stop(code=0){if(closing)return;closing=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>process.exit(code),700);}
for(const child of children)child.on('exit',code=>stop(code||0));
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
