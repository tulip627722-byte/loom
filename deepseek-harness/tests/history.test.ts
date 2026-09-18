import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore UI module is JavaScript; test the actual native wire format.
import {threadFromHistory} from '../../deepseek-harness-ui/src/harnessClient.js';
test('native tool-result links to its call and preserves errors',()=>{
  const rows=threadFromHistory([
    {event:{type:'tool/call',seq:1,data:{callId:'c',name:'bash',arguments:'{}'}}},
    {event:{type:'tool/result',seq:2,data:{message:{source:{callId:'c'},content:[{type:'tool-result',toolCallId:'c',isError:true,content:[{type:'text',text:'denied'}]}]}}}}
  ]);
  assert.equal(rows.length,1);assert.equal(rows[0].tool,'bash');assert.equal(rows[0].status,'error');assert.match(rows[0].detail,/denied/);
});
