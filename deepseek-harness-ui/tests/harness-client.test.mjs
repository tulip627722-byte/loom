import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationFromHistory,
  hasTurnEndedAfter,
  latestSeq,
  titleFromSummary,
} from "../src/harnessClient.js";

test("folds finalized Harness messages into the compact UI conversation", () => {
  const entries = [
    { event: { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "你好" }] } } },
    { event: { type: "assistant/chunk", seq: 2, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "你" } } } },
    { event: { type: "assistant/message", seq: 3, data: { message: { content: [{ type: "text", text: "你好呀" }], source: { model: "DeepSeek-V4-Flash" } } } } },
    { event: { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "stop" } } } },
  ];

  assert.deepEqual(conversationFromHistory(entries), [
    { type: "user", text: "你好", seq: 1 },
    { type: "assistant", text: "你好呀", seq: 3, model: "DeepSeek-V4-Flash" },
  ]);
  assert.equal(latestSeq(entries), 4);
  assert.equal(hasTurnEndedAfter(entries, 1), true);
  assert.equal(hasTurnEndedAfter(entries, 4), false);
});

test("keeps an in-flight text delta visible until the final message arrives", () => {
  const entries = [
    { event: { type: "assistant/chunk", seq: 5, data: { turn: 2, step: 1, chunk: { type: "text-delta", text: "正在" } } } },
    { event: { type: "assistant/chunk", seq: 6, data: { turn: 2, step: 1, chunk: { type: "text-delta", text: "思考" } } } },
  ];
  assert.deepEqual(conversationFromHistory(entries), [
    { type: "assistant", text: "正在思考", partial: true },
  ]);
});

test("reads persisted titles and falls back for blank sessions", () => {
  assert.equal(titleFromSummary({ projections: { values: { title: "真实会话" } } }), "真实会话");
  assert.equal(titleFromSummary({ projections: { values: { title: null } } }), "新会话");
});
