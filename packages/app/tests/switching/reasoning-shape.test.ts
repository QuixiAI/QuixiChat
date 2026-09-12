import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderInput } from "@quixi/providers";
import { shapeReasoningForTarget, withReasoningShape } from "../../src/runtime/reasoning.ts";
import { describePortability, describeTransformations } from "../../src/runtime/portability.ts";
import type { PortabilityTarget, Transformations } from "../../src/runtime/portability.ts";
const id = () => crypto.randomUUID();
const text = (messageId: string, order: number, value: string) => ({ id: id(), messageId, order, kind: "Text" as const, data: { text: value } });
const marker = (messageId: string, order: number, redacted = false) => ({ id: id(), messageId, order, kind: "ReasoningMetadata" as const, data: { redacted, summary: null } });
const block = { type: "thinking" as const, thinking: "verified", signature: "sig" };
/** Two assistant turns: the first with a verified block, the second with an
 * unverifiable marker (an import or a stream without retained receipts). */
function branch(options: { toolLoop?: boolean } = {}) {
  const first = id(), second = id();
  const verified = marker(first, 0), unverified = marker(second, 0);
  const messages: ProviderInput["messages"][number][] = [
    { role: "user", parts: [text(id(), 0, "Q1")] },
    { role: "assistant", parts: [verified, text(first, 1, "A1")] },
    { role: "user", parts: [text(id(), 0, "Q2")] },
    { role: "assistant", parts: [unverified, text(second, 1, "A2")] },
  ];
  if (options.toolLoop)
    messages.push({ role: "user", parts: [{ id: id(), messageId: id(), order: 0, kind: "ToolResult", data: { callPartId: null, content: "result", isError: false, unresolvedProviderCallId: "call-1" } }] });
  else messages.push({ role: "user", parts: [text(id(), 0, "Q3")] });
  const input: ProviderInput = {
    requestId: id(), modelId: "claude-haiku-4-5-20251001", systemPrompt: null, messages,
    reasoning: { [verified.id]: { protocol: "anthropic", modelId: "claude-haiku-4-5-20251001", messageId: first, index: 0, block } },
    parameters: { maxOutputTokens: 2048 },
  };
  return { input, verified, unverified };
}
test("the producing model keeps its verified block and only unverifiable markers are omitted, counted", () => {
  const { input, verified, unverified } = branch();
  const shape = shapeReasoningForTarget(input, { protocol: "anthropic", modelId: "claude-haiku-4-5-20251001" });
  assert.deepEqual(shape.transformed, { reasoningOmittedUnverified: 1 });
  assert.equal(shape.emptyAssistant, 0);
  assert.deepEqual(shape.input.messages[1]!.parts.map((part) => part.id), [verified.id, input.messages[1]!.parts[1]!.id]);
  assert.deepEqual(shape.input.messages[3]!.parts.map((part) => part.kind), ["Text"]);
  assert.equal(shape.input.messages[3]!.parts.some((part) => part.id === unverified.id), false);
  assert.equal(shape.input.reasoning, input.reasoning);
  assert.equal(shape.input.messages[0], input.messages[0], "untouched messages keep identity");
});
test("another model or protocol receives no thinking blocks, each omission counted by cause", () => {
  const { input } = branch();
  for (const target of [{ protocol: "anthropic" as const, modelId: "claude-other" }, { protocol: "openai-compatible" as const, modelId: "gpt-4.1-mini-2025-04-14" }]) {
    const shape = shapeReasoningForTarget(input, target);
    assert.deepEqual(shape.transformed, { reasoningOmittedUnverified: 1, reasoningOmittedForeign: 1 });
    assert.ok(shape.input.messages.every((message) => message.parts.every((part) => part.kind !== "ReasoningMetadata")));
    assert.equal(shape.input.messages.length, input.messages.length);
  }
});
test("markers inside a tool-use loop are kept for the mapper's own refusal, and marker-only turns are dropped as empty", () => {
  const loop = branch({ toolLoop: true });
  const shape = shapeReasoningForTarget(loop.input, { protocol: "openai-compatible", modelId: "gpt-4.1-mini-2025-04-14" });
  assert.deepEqual(shape.transformed, { reasoningOmittedForeign: 1 });
  assert.ok(shape.input.messages[3]!.parts.some((part) => part.id === loop.unverified.id), "the turn a tool result follows keeps its marker");
  const only = branch();
  only.input.messages = only.input.messages.map((message, at) => at === 3 ? { ...message, parts: message.parts.filter((part) => part.kind === "ReasoningMetadata") } : message);
  const dropped = shapeReasoningForTarget(only.input, { protocol: "anthropic", modelId: "claude-haiku-4-5-20251001" });
  assert.equal(dropped.emptyAssistant, 1);
  assert.equal(dropped.input.messages.length, only.input.messages.length - 1);
  assert.deepEqual(dropped.transformed, { reasoningOmittedUnverified: 1 });
  const untouched = shapeReasoningForTarget({ ...only.input, messages: [only.input.messages[0]!] }, { protocol: "anthropic", modelId: "x" });
  assert.deepEqual(untouched.transformed, {});
});
test("portability wording names reasoning omissions per target", () => {
  const base: Transformations = { inlinedBlobText: 0, unavailableImages: 0 };
  const shaped = withReasoningShape(base, { input: branch().input, transformed: { reasoningOmittedForeign: 2, reasoningOmittedUnverified: 1 }, emptyAssistant: 0 });
  assert.deepEqual(describeTransformations(shaped), [
    "1 reasoning marker without a verified provider block omitted, as the thinking contract permits outside tool use",
    "2 thinking blocks from another model omitted because only the producing model can read them",
  ]);
  const report = { target: { protocol: "anthropic" as const, modelId: "m" }, preserved: { parts: 4, byKind: { Text: 4 } }, blocked: [], constraints: [], requestBytes: 10, sendable: true, context: { contextWindow: null, maxOutputTokens: 1024, inputRoom: null }, pricing: null };
  const targets: PortabilityTarget[] = [
    { provider: { id: "anthropic", label: "Anthropic" }, model: { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" }, report },
    { provider: { id: "openai", label: "OpenAI" }, model: { id: "gpt", name: "GPT-4.1 mini" }, report, transformed: { ...base, reasoningOmittedForeign: 1 } },
  ];
  const assessment = describePortability(targets, base, { internalProvenance: 0, emptyAssistant: 0 });
  assert.equal(assessment.status, "portable_with_transformations");
  assert.equal(assessment.summary, "Every configured target can carry the active path; some targets omit reasoning blocks they cannot read or verify.");
  assert.equal(assessment.reasons[0], "Anthropic · Claude Haiku 4.5: carries all 4 parts.");
  assert.equal(assessment.reasons[1], "OpenAI · GPT-4.1 mini: carries all 4 parts; 1 thinking block from another model omitted because only the producing model can read them.");
});
