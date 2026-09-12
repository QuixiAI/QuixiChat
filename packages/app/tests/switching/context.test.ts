import test from "node:test";
import assert from "node:assert/strict";
import type { CompatibilityReport } from "@quixi/providers";
import type { Cost } from "@quixi/core/model";
import { describeSwitchContext } from "../../src/runtime/switching.ts";

const report = (
  overrides: Partial<CompatibilityReport> = {},
): CompatibilityReport => ({
  target: { protocol: "anthropic", modelId: "synthetic-model" },
  preserved: { parts: 3, byKind: { Text: 3 } },
  blocked: [],
  constraints: [],
  requestBytes: 1_200,
  sendable: true,
  context: { contextWindow: 8_192, maxOutputTokens: 1_024, inputRoom: 7_168 },
  pricing: {
    currency: "USD",
    inputPerMillion: "1",
    outputPerMillion: "5",
    cachedInputPerMillion: null,
    cacheWriteInputPerMillion: null,
    sourceUrl: "https://example.invalid/pricing",
    verifiedAt: Date.UTC(2026, 8, 9),
  },
  ...overrides,
});
const usd = (perMillion: number) => (count: number): Cost => ({
  amount: ((count * perMillion) / 1_000_000).toFixed(9),
  currency: "USD",
});
const costs = { input: usd(1), output: usd(5) };
const target = { label: "Anthropic", countsTokens: true };

test("without a count the report shows the room, asks for a count and quotes the reviewed rates", () => {
  const context = describeSwitchContext(report(), null, costs, target);
  assert.equal(context.inputRoom, 7_168);
  assert.equal(context.overRoomBy, 0);
  assert.deepEqual(context.lines, [
    "Context: target window 8,192 tokens · requested output 1,024 · room for input 7,168 tokens.",
    "Count prompt tokens to compare this draft and branch with the room; counting sends them to Anthropic.",
    "Cost: reviewed rates are 1.00 USD per million input tokens and 5.00 USD per million output tokens, reviewed 2026-09-09; count the prompt for an input estimate.",
  ]);
});

test("a count that fits reports the spare room and an input plus bounded output estimate", () => {
  const context = describeSwitchContext(report(), { tokens: 5_000, label: "Anthropic" }, costs, target);
  assert.equal(context.overRoomBy, 0);
  assert.equal(context.lines[1], "Current prompt: 5,000 tokens counted by Anthropic · fits with 2,168 tokens to spare.");
  assert.equal(
    context.lines[2],
    "Cost: ≈ 0.005 USD for the counted input plus up to ≈ 0.00512 USD for 1,024 output tokens, estimated from reviewed pricing (1.00 USD per million input tokens and 5.00 USD per million output tokens, reviewed 2026-09-09).",
  );
});

test("a count over the room states the excess and that compaction is not available", () => {
  const context = describeSwitchContext(report(), { tokens: 7_500, label: "Anthropic" }, costs, target);
  assert.equal(context.overRoomBy, 332);
  assert.match(context.lines[1] ?? "", /exceeds the room by 332 tokens\. Review attachment exclusions/);
});

test("a connection without a count endpoint, an unknown window and no price are each stated", () => {
  const context = describeSwitchContext(
    report({ context: { contextWindow: null, maxOutputTokens: 512, inputRoom: null }, pricing: null }),
    null,
    costs,
    { label: "OpenAI", countsTokens: false },
  );
  assert.equal(context.inputRoom, null);
  assert.deepEqual(context.lines, [
    "Context: the catalog records no context window for synthetic-model; requested output 512 tokens.",
    "Token counting is unavailable for OpenAI; the encoded request is 1,200 bytes.",
    "Cost: no reviewed price for this model.",
  ]);
  const counted = describeSwitchContext(
    report({ context: { contextWindow: null, maxOutputTokens: 512, inputRoom: null } }),
    { tokens: 9, label: "OpenAI" },
    costs,
    { label: "OpenAI", countsTokens: false },
  );
  assert.equal(counted.overRoomBy, 0);
  assert.match(counted.lines[1] ?? "", /the room is unknown, so the provider decides/);
});
