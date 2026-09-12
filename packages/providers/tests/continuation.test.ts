import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWebHost } from "../../../apps/web/src/host/index.ts";
import type { ContentPart } from "@quixi/core/model";
import {
  adapterCatalog,
  bindReasoningEvidence,
  CompatibilityError,
  createAnthropicAdapter,
  createOpenAICompatibleAdapter,
  initialProviderCatalogs,
  LIMITS,
  Normalizer,
  parseThinkingReceipt,
  reconstructThinkingReceipts,
  ReasoningEvidenceError,
  SSEDecoder,
  THINKING_RECEIPT_KIND,
  type ProviderEvent,
  type ProviderInput,
  type ThinkingReceipt,
} from "../src/index.ts";
import { fixture, input, model } from "./fixtures.ts";
const id = () => crypto.randomUUID();
const nextId = () => crypto.randomUUID();
const host = { startProviderHttp() { throw new Error("no transport"); } } as never;
const binding = (protocol: "anthropic" | "openai-compatible") => ({ providerId: protocol, accountId: "fixture", destinationId: protocol, transportId: "fixture" });
const thinkingModel = model("anthropic", "synthetic-model", { thinking: true });
const anthropic = createAnthropicAdapter({ host, binding: binding("anthropic"), credential: null, catalog: [thinkingModel, model("anthropic", "plain-model")], nextId, now: Date.now });
const openai = createOpenAICompatibleAdapter({ host, binding: binding("openai-compatible"), credential: null, catalog: [model("openai-compatible")], nextId, now: Date.now });
const codes = (report: { blocked: { code: string }[]; constraints: { code: string }[] }) =>
  [...report.blocked.map((item) => item.code), ...report.constraints.map((item) => item.code)].sort();
const signed = { type: "thinking", thinking: "﻿ first\n\"🧪\" ", signature: "opaque+/==\n" } as const;
const redacted = { type: "redacted_thinking", data: "synthetic-encrypted+/=" } as const;
/** A branch whose assistant turn carries two verified blocks before its text. */
function branch(modelId = "synthetic-model") {
  const assistantId = id(), markerA = id(), markerB = id();
  const messages: ProviderInput["messages"] = [
    { role: "user", parts: [{ id: id(), messageId: id(), order: 0, kind: "Text", data: { text: "Question" } }] },
    { role: "assistant", parts: [
      { id: markerA, messageId: assistantId, order: 0, kind: "ReasoningMetadata", data: { redacted: false, summary: null } },
      { id: markerB, messageId: assistantId, order: 1, kind: "ReasoningMetadata", data: { redacted: true, summary: null } },
      { id: id(), messageId: assistantId, order: 2, kind: "Text", data: { text: "Answer" } },
    ] },
    { role: "user", parts: [{ id: id(), messageId: id(), order: 0, kind: "Text", data: { text: "Follow-up" } }] },
  ];
  const reasoning: NonNullable<ProviderInput["reasoning"]> = {
    [markerA]: { protocol: "anthropic", modelId, messageId: assistantId, index: 1, block: { ...signed } },
    [markerB]: { protocol: "anthropic", modelId, messageId: assistantId, index: 3, block: { ...redacted } },
  };
  const value: ProviderInput = { ...input(modelId), messages, reasoning, parameters: { maxOutputTokens: 2048 } };
  return { value, assistantId, markerA, markerB };
}
test("manual thinking maps to Anthropic's enabled budget only under the reviewed profile and its constraints", () => {
  const base = { ...input(), parameters: { maxOutputTokens: 2048, thinkingBudgetTokens: 1024 } };
  const prepared = anthropic.prepare(base);
  assert.deepEqual(prepared.body.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.equal(prepared.body.max_tokens, 2048);
  assert.equal(anthropic.analyze(base).sendable, true);
  const refused = (parameters: ProviderInput["parameters"], modelId = "synthetic-model") =>
    codes(anthropic.analyze({ ...input(modelId), parameters }));
  assert.deepEqual(refused({ maxOutputTokens: 2048, thinkingBudgetTokens: 1023 }), ["thinking_budget"]);
  assert.deepEqual(refused({ maxOutputTokens: 2048, thinkingBudgetTokens: 2048 }), ["thinking_budget"]);
  assert.deepEqual(refused({ maxOutputTokens: 2048, thinkingBudgetTokens: 1024.5 }), ["thinking_budget"]);
  assert.deepEqual(refused({ maxOutputTokens: 2048, thinkingBudgetTokens: 1024, temperature: 0.2 }), ["thinking_temperature"]);
  assert.deepEqual(refused({ maxOutputTokens: 2048, thinkingBudgetTokens: 1024, topP: 0.5 }), ["thinking_top_p"]);
  assert.deepEqual(refused({ maxOutputTokens: 2048, thinkingBudgetTokens: 1024, topP: 0.97 }), []);
  assert.deepEqual(refused({ maxOutputTokens: 1024, thinkingBudgetTokens: 1024, temperature: 1 }), ["thinking_budget", "thinking_temperature"]);
  // A reviewed Anthropic entry without the profile, and any OpenAI entry, refuse the parameter by name.
  assert.deepEqual(refused({ maxOutputTokens: 1000, thinkingBudgetTokens: 1024 }, "plain-model"), ["parameter_unsupported", "thinking_unsupported"]);
  assert.deepEqual(codes(openai.analyze({ ...input(), parameters: { maxOutputTokens: 100, thinkingBudgetTokens: 1024 } })), ["parameter_unsupported", "thinking_unsupported"]);
  assert.throws(() => anthropic.prepare({ ...input(), parameters: { maxOutputTokens: 100, thinkingBudgetTokens: 1024 } }), (error: unknown) => error instanceof CompatibilityError && error.issues.some((issue) => issue.code === "thinking_budget"));
});
test("the shipped Haiku 4.5 catalog declares the manual-thinking profile with dated sources", () => {
  const catalog = initialProviderCatalogs().find((entry) => entry.providerId === "anthropic")!;
  const effective = adapterCatalog(catalog)[0]!;
  assert.equal(effective.capabilities.thinkingProfile, "anthropic-manual-haiku-4.5");
  assert.equal(effective.capabilities.reasoning, "supported");
  assert.ok(effective.capabilities.parameters.includes("thinkingBudgetTokens"));
  assert.ok(catalog.review.sources.includes("https://platform.claude.com/docs/en/build-with-claude/extended-thinking"));
  assert.ok(catalog.limitations.some((value) => value.includes("1,024 tokens")));
  const adapter = createAnthropicAdapter({ host, binding: binding("anthropic"), credential: null, catalog: [effective], nextId, now: Date.now });
  const body = adapter.prepare({ ...input(effective.id), parameters: { maxOutputTokens: 4000, thinkingBudgetTokens: 2000 } }).body;
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 2000 });
  const gpt = adapterCatalog(initialProviderCatalogs().find((entry) => entry.providerId === "openai")!)[0]!;
  assert.equal(gpt.capabilities.thinkingProfile, undefined);
  assert.equal(gpt.capabilities.parameters.includes("thinkingBudgetTokens"), false);
});
test("verified thinking and redacted blocks are carried first, in order, exactly as captured", () => {
  const { value } = branch();
  const report = anthropic.analyze(value);
  assert.equal(report.sendable, true, JSON.stringify(report));
  assert.equal(report.preserved.byKind.ReasoningMetadata, 2);
  const prepared = anthropic.prepare(value);
  const assistant = (prepared.body.messages as { role: string; content: unknown[] }[])[1]!;
  assert.deepEqual(assistant.content, [{ ...signed }, { ...redacted }, { type: "text", text: "Answer" }]);
  // Inspection, count and send build the same wire body from the same input.
  assert.deepEqual(anthropic.prepare(value).body, prepared.body);
  assert.equal(report.requestBytes, new TextEncoder().encode(JSON.stringify(prepared.body)).length);
});
test("every unverifiable, foreign, misordered or oversized reasoning marker is a named refusal", () => {
  const missing = branch(); delete (missing.value.reasoning as Record<string, unknown>)[missing.markerB];
  assert.deepEqual(codes(anthropic.analyze(missing.value)), ["reasoning_evidence_missing"]);
  const summaryOnly = branch(); const { reasoning: _dropped, ...withoutEvidence } = summaryOnly.value; summaryOnly.value = withoutEvidence;
  (summaryOnly.value.messages[1]!.parts[0] as { data: { summary: string | null } }).data.summary = "A display summary is not a signed block";
  assert.deepEqual(codes(anthropic.analyze(summaryOnly.value)), ["reasoning_evidence_missing", "reasoning_evidence_missing"]);
  const other = branch("plain-model"); other.value.parameters = { maxOutputTokens: 1000 };
  assert.deepEqual(codes(anthropic.analyze(other.value)), ["reasoning_model_mismatch", "reasoning_model_mismatch"]);
  const foreignModel = branch(); foreignModel.value.reasoning![foreignModel.markerA]!.modelId = "another-model";
  assert.deepEqual(codes(anthropic.analyze(foreignModel.value)), ["reasoning_model_mismatch"]);
  const foreignMessage = branch(); foreignMessage.value.reasoning![foreignMessage.markerA]!.messageId = id();
  assert.deepEqual(codes(anthropic.analyze(foreignMessage.value)), ["reasoning_evidence_mismatch"]);
  const flag = branch(); (flag.value.messages[1]!.parts[1] as { data: { redacted: boolean } }).data.redacted = false;
  assert.deepEqual(codes(anthropic.analyze(flag.value)), ["reasoning_evidence_invalid"]);
  const unsigned = branch(); (unsigned.value.reasoning![unsigned.markerA]!.block as { signature: string }).signature = "";
  assert.deepEqual(codes(anthropic.analyze(unsigned.value)), ["reasoning_evidence_invalid"]);
  const extended = branch(); (extended.value.reasoning![extended.markerA]!.block as Record<string, unknown>).extra = 1;
  assert.deepEqual(codes(anthropic.analyze(extended.value)), ["reasoning_evidence_invalid"]);
  const descending = branch(); descending.value.reasoning![descending.markerB]!.index = 0;
  assert.deepEqual(codes(anthropic.analyze(descending.value)), ["reasoning_order"]);
  const late = branch(); const parts = [...late.value.messages[1]!.parts]; late.value.messages[1]!.parts = [parts[2]!, parts[0]!, parts[1]!];
  assert.deepEqual(codes(anthropic.analyze(late.value)), ["reasoning_order", "reasoning_order"]);
  const user = branch(); user.value.messages = user.value.messages.map((message, at) => at === 1 ? { ...message, role: "user" } : message);
  assert.deepEqual(codes(anthropic.analyze(user.value)), ["reasoning_role", "reasoning_role"]);
  const big = branch(); (big.value.reasoning![big.markerA]!.block as { thinking: string }).thinking = "x".repeat(LIMITS.reasoningBlockBytes);
  assert.deepEqual(codes(anthropic.analyze(big.value)), ["reasoning_limit"]);
  const evidence = branch();
  evidence.value.messages[1]!.parts = [...evidence.value.messages[1]!.parts,
    { id: id(), messageId: evidence.assistantId, order: 3, kind: "ProviderArtifact", data: { providerKind: THINKING_RECEIPT_KIND, rawObjectId: id(), locator: "block/1" } },
    { id: id(), messageId: evidence.assistantId, order: 4, kind: "ProviderArtifact", data: { providerKind: "thinking", rawObjectId: id(), locator: "generation-stream/record/5" } }];
  assert.deepEqual(codes(anthropic.analyze(evidence.value)), ["reasoning_evidence_part", "reasoning_evidence_part"]);
  // The Chat Completions profile has no input representation for these blocks.
  const cross = branch(); cross.value.modelId = "synthetic-model";
  assert.deepEqual(codes(openai.analyze({ ...cross.value, parameters: { maxOutputTokens: 100 } })), ["reasoning_unsupported", "reasoning_unsupported"]);
});
function receipt(overrides: Partial<Omit<ThinkingReceipt, "source">> & { source?: Partial<ThinkingReceipt["source"]> } = {}): ThinkingReceipt {
  return {
    version: 1, protocol: "anthropic", generationId: "11111111-1111-4111-8111-111111111111", outputMessageId: "22222222-2222-4222-8222-222222222222",
    responseId: "msg-synthetic", model: "synthetic-model", returnedModel: "synthetic-model", index: 1,
    ...overrides,
    source: { startRecord: 4, endRecord: 8, rawSegmentsThroughCheckpoint: 3, rawBytesThroughCheckpoint: 400, ...(overrides.source ?? {}) },
    block: overrides.block ?? { ...signed },
  };
}
test("receipt parsing accepts exactly the version-1 contract", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const good = receipt();
  assert.deepEqual(parseThinkingReceipt(encode(good)), good);
  assert.deepEqual(parseThinkingReceipt(encode(receipt({ block: { ...redacted }, returnedModel: null }))).block, { ...redacted });
  const refused = (value: unknown, code: string) =>
    assert.throws(() => parseThinkingReceipt(value instanceof Uint8Array ? value : encode(value)), (error: unknown) => error instanceof ReasoningEvidenceError && error.code === code, code);
  refused({ ...good, version: 2 }, "reasoning_receipt_invalid");
  refused({ ...good, protocol: "openai-compatible" }, "reasoning_receipt_invalid");
  refused({ ...good, block: { type: "thinking", thinking: "x", signature: "" } }, "reasoning_receipt_invalid");
  refused({ ...good, block: { ...signed, extra: true } }, "reasoning_receipt_invalid");
  refused({ ...good, source: { ...good.source, endRecord: 4 } }, "reasoning_receipt_invalid");
  refused({ ...good, generationId: "not-an-id" }, "reasoning_receipt_invalid");
  refused([good], "reasoning_receipt_malformed");
  refused(new Uint8Array([0xff, 0xfe]), "reasoning_receipt_malformed");
  refused(new Uint8Array(LIMITS.reasoningReceiptBytes + 1), "reasoning_receipt_limit");
  refused({ ...good, block: { ...signed, thinking: "y".repeat(LIMITS.reasoningBlockBytes) } }, "reasoning_receipt_limit");
});
/** Output parts in the order the generation consumer commits them. */
function outputParts(messageId: string, receiptIds: string[]): ContentPart[] {
  const part = (order: number, kind: ContentPart["kind"], data: ContentPart["data"]) => ({ id: id(), messageId, order, kind, data }) as ContentPart;
  const raw = (order: number) => part(order, "ProviderArtifact", { providerKind: "quixi.provider.raw-stream-chunk", rawObjectId: id(), locator: `bytes/${order}/10` });
  return [
    raw(0), part(1, "Text", { text: "Hello" }), raw(2),
    part(3, "ReasoningMetadata", { redacted: false, summary: null }),
    part(4, "ProviderArtifact", { providerKind: "thinking", rawObjectId: id(), locator: "generation-stream/record/4" }),
    raw(5), part(6, "ProviderArtifact", { providerKind: THINKING_RECEIPT_KIND, rawObjectId: receiptIds[0]!, locator: "block/1" }),
    part(7, "ReasoningMetadata", { redacted: true, summary: null }),
    part(8, "ProviderArtifact", { providerKind: "redacted_thinking", rawObjectId: id(), locator: "generation-stream/record/9" }),
    part(9, "ProviderArtifact", { providerKind: THINKING_RECEIPT_KIND, rawObjectId: receiptIds[1]!, locator: "block/3" }),
    raw(10), part(11, "ProviderArtifact", { providerKind: "quixi.provider.response-manifest", rawObjectId: id(), locator: "manifest" }),
  ];
}
test("markers bind to receipts only when generation, response, kinds, records and order all agree", () => {
  const message = { id: "22222222-2222-4222-8222-222222222222", generationId: "11111111-1111-4111-8111-111111111111", model: "synthetic-model" };
  const receipts = [receipt({ index: 1, source: { startRecord: 4, endRecord: 8 } }), receipt({ index: 3, block: { ...redacted }, source: { startRecord: 9, endRecord: 10 } })];
  const parts = outputParts(message.id, [id(), id()]);
  const bound = bindReasoningEvidence(message, parts, [...receipts].reverse());
  assert.deepEqual(bound.unbound, []);
  const markers = parts.filter((part) => part.kind === "ReasoningMetadata");
  assert.deepEqual(bound.reasoning[markers[0]!.id], { protocol: "anthropic", modelId: "synthetic-model", messageId: message.id, index: 1, block: { ...signed } });
  assert.deepEqual(bound.reasoning[markers[1]!.id], { protocol: "anthropic", modelId: "synthetic-model", messageId: message.id, index: 3, block: { ...redacted } });
  assert.equal(bound.evidencePartIds.length, 4);
  const failure = (value: ReturnType<typeof bindReasoningEvidence>, code: string) => {
    assert.deepEqual(value.reasoning, {}); assert.deepEqual(value.unbound.map((item) => item.code), [code, code]);
  };
  failure(bindReasoningEvidence({ ...message, generationId: null }, parts, receipts), "reasoning_source_unknown");
  failure(bindReasoningEvidence(message, parts.filter((part) => part.kind !== "ProviderArtifact" || part.data.providerKind !== "thinking"), receipts), "reasoning_source_mismatch");
  failure(bindReasoningEvidence(message, parts, []), "reasoning_evidence_missing");
  failure(bindReasoningEvidence(message, parts, [receipts[0]!]), "reasoning_receipt_count");
  failure(bindReasoningEvidence(message, parts, [receipts[0]!, receipt({ index: 3, block: { ...redacted }, generationId: id(), source: { startRecord: 9, endRecord: 10 } })]), "reasoning_receipt_foreign");
  failure(bindReasoningEvidence({ ...message, model: "other" }, parts, receipts), "reasoning_receipt_foreign");
  failure(bindReasoningEvidence(message, parts, [receipts[0]!, receipt({ index: 3, block: { ...redacted }, source: { startRecord: 8, endRecord: 10 } })]), "reasoning_evidence_mismatch");
  failure(bindReasoningEvidence(message, parts, [receipts[0]!, receipt({ index: 3, block: { ...redacted }, responseId: "msg-other", source: { startRecord: 9, endRecord: 10 } })]), "reasoning_evidence_mismatch");
  failure(bindReasoningEvidence(message, parts, [receipts[0]!, receipt({ index: 3, block: { ...signed }, source: { startRecord: 9, endRecord: 10 } })]), "reasoning_evidence_mismatch");
  failure(bindReasoningEvidence(message, parts, [receipt({ index: 1, source: { startRecord: 4, endRecord: 8 } }), receipt({ index: 3, block: { ...redacted }, source: { startRecord: 7, endRecord: 10 } })]), "reasoning_evidence_mismatch");
  // An imported marker with a summary and no retained stream binds nothing.
  const imported = bindReasoningEvidence(message, [{ id: id(), messageId: message.id, order: 0, kind: "ReasoningMetadata", data: { redacted: false, summary: "imported summary" } }], receipts);
  assert.deepEqual(imported.unbound.map((item) => item.code), ["reasoning_source_mismatch"]);
  assert.deepEqual(bindReasoningEvidence(message, [{ id: id(), messageId: message.id, order: 0, kind: "Text", data: { text: "no markers" } }], []), { reasoning: {}, unbound: [], evidencePartIds: [] });
});
test("retained raw segments reconstruct the same receipts the live consumer would have written", () => {
  const bytes = new TextEncoder().encode(fixture("anthropic"));
  const segments: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += 137) segments.push(bytes.subarray(at, at + 137));
  const expected = { generationId: id(), outputMessageId: id(), model: "synthetic-model" };
  const rebuilt = reconstructThinkingReceipts(segments, expected);
  const parser = new SSEDecoder(), normalizer = new Normalizer("anthropic"), live: ProviderEvent[] = [];
  for (const record of parser.push(bytes, true)) live.push(...normalizer.accept(record));
  const blocks = live.filter((event) => event.type === "reasoning_block");
  assert.equal(blocks.length, 2);
  assert.deepEqual(rebuilt.map((item) => [item.index, item.source.startRecord, item.source.endRecord, item.block]),
    blocks.map((event) => event.type === "reasoning_block" && [event.index, event.startRecord, event.endRecord, event.block]));
  assert.deepEqual(rebuilt.map((item) => [item.protocol, item.responseId, item.model, item.returnedModel, item.generationId, item.outputMessageId]),
    rebuilt.map(() => ["anthropic", "msg-synthetic", "synthetic-model", "synthetic-model", expected.generationId, expected.outputMessageId]));
  assert.ok(rebuilt.every((item) => item.source.rawBytesThroughCheckpoint <= bytes.length && item.source.rawSegmentsThroughCheckpoint <= segments.length));
  for (const item of rebuilt) assert.deepEqual(parseThinkingReceipt(new TextEncoder().encode(JSON.stringify(item))), item);
  const refused = (value: Uint8Array[], code: string) =>
    assert.throws(() => reconstructThinkingReceipts(value, expected), (error: unknown) => error instanceof ReasoningEvidenceError && error.code === code, code);
  refused([new TextEncoder().encode(fixture("anthropic", "truncated"))], "reasoning_reconstruction_incomplete");
  refused([new TextEncoder().encode(fixture("anthropic", "malformed"))], "reasoning_reconstruction_failed");
  refused([new TextEncoder().encode('{"error":{"type":"overloaded_error"}}')], "reasoning_reconstruction_failed");
  refused([new Uint8Array(LIMITS.reasoningReconstructionBytes), new Uint8Array(1)], "reasoning_reconstruction_limit");
});
test("count and generation requests carry the same thinking parameter and blocks through actual HTTP", async () => {
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url!, body });
    if (req.url === "/v1/messages/count_tokens") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ input_tokens: 42 })); }
    else { res.setHeader("content-type", "text/event-stream"); res.end(fixture("anthropic")); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const web = createWebHost({ destinations: [{ binding: binding("anthropic"), baseUrl: `http://127.0.0.1:${port}`, allowInsecureLoopback: true, routes: ["/v1/messages", "/v1/messages/count_tokens"].map((path) => ({ path, methods: ["POST"], headers: ["content-type", "anthropic-version"] })), credential: { header: "x-api-key", prefix: "" }, transport: { kind: "browser_direct", privacy: "local", relayIdentity: null } }] });
  try {
    const adapter = createAnthropicAdapter({ host: web, binding: binding("anthropic"), credential: null, catalog: [thinkingModel], nextId, now: Date.now });
    const { value } = branch();
    value.parameters = { maxOutputTokens: 2048, thinkingBudgetTokens: 1500, topP: 0.95 };
    const expected = adapter.prepare(value).body;
    const count = await adapter.countTokens(value);
    assert.equal(count.tokens, 42);
    const counted = requests.at(-1)!;
    assert.equal(counted.path, "/v1/messages/count_tokens");
    assert.deepEqual(counted.body.thinking, { type: "enabled", budget_tokens: 1500 });
    assert.deepEqual(counted.body.messages, expected.messages);
    assert.equal("max_tokens" in counted.body, false); assert.equal("top_p" in counted.body, false);
    const events: ProviderEvent[] = [];
    for await (const event of adapter.stream(value).events) events.push(event);
    assert.equal((events.at(-1) as { status: string }).status, "complete");
    assert.deepEqual(requests.at(-1)!.body, expected);
    assert.deepEqual(requests.at(-1)!.body.messages[1].content.slice(0, 2), [{ ...signed }, { ...redacted }]);
    assert.equal(requests.at(-1)!.body.top_p, 0.95);
  } finally { await web.dispose(); server.close(); }
});
