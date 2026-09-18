import test from "node:test";
import assert from "node:assert/strict";
import { threadFromHistory,effectivePlanMode,tokenTelemetry } from "../src/harnessClient.js";

test("finalized assistant text replaces its streaming draft", () => {
  const items = threadFromHistory([
    { event: { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "完成" } } } },
    { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "完成" }] } } } },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "完成");
  assert.equal(items[0].partial, undefined);
});

test("permission configuration is not a request for approval", () => {
  assert.deepEqual(threadFromHistory([{ event: { type: "permission/config", data: {} } }]), []);
});

test("plan mode follows the native durable projection",()=>{
  assert.equal(effectivePlanMode({plan:{active:false,pending:false}}),false);
  assert.equal(effectivePlanMode({plan:{active:false,pending:true}}),true);
  assert.equal(effectivePlanMode({plan:{active:true,pending:true}}),false);
});

test("token telemetry keeps disjoint usage buckets and context pressure",()=>{
  const value=tokenTelemetry({tokenUsage:{uncachedInputTokens:100,cacheReadTokens:40,cacheWriteTokens:10,outputTokens:50},contextPressure:{projectedTokens:400,contextWindow:1000},contextBreakdown:{systemTokens:20,toolsTokens:30,messageTokens:80}});
  assert.deepEqual(value,{input:150,output:50,total:200,used:400,capacity:1000,percent:40,breakdown:{system:20,tools:30,messages:80}});
});
