import test from "node:test";
import assert from "node:assert/strict";
import type { ContentPart } from "@quixi/core/model";
import { transformOutputPart } from "../../src/runtime/output-parts.ts";
import { describeTransformations } from "../../src/runtime/portability.ts";
const id = () => crypto.randomUUID();
const part = (kind: ContentPart["kind"], data: ContentPart["data"]): ContentPart => ({ id: id(), messageId: id(), order: 3, kind, data }) as ContentPart;
test("a citation becomes a plain source note that keeps the part identity, or nothing when it names nothing", () => {
  const cited = part("Citation", { url: "https://example.invalid/source", label: "Synthetic citation", sourcePartId: null });
  const result = transformOutputPart(cited);
  assert.equal(result.transformation, "citationsTransformed");
  assert.deepEqual(result.part, { id: cited.id, messageId: cited.messageId, order: 3, kind: "Text", data: { text: "[Source: Synthetic citation — https://example.invalid/source]" } });
  assert.equal((transformOutputPart(part("Citation", { url: null, label: " Label ", sourcePartId: null })).part as { data: { text: string } }).data.text, "[Source: Label]");
  assert.equal((transformOutputPart(part("Citation", { url: "https://example.invalid/only", label: null, sourcePartId: null })).part as { data: { text: string } }).data.text, "[Source: https://example.invalid/only]");
  assert.deepEqual(transformOutputPart(part("Citation", { url: null, label: "", sourcePartId: null })), { part: null, transformation: "citationsTransformed" });
});
test("provider refusal markers are dropped, other structured values are flattened to JSON text within a bound", () => {
  assert.deepEqual(transformOutputPart(part("StructuredData", { value: { type: "provider_refusal" } })), { part: null, transformation: "providerArtifactsDegraded" });
  const flattened = transformOutputPart(part("StructuredData", { value: { answer: 42, items: ["a", "b"] } }));
  assert.equal(flattened.transformation, "structuredDataFlattened");
  assert.equal((flattened.part as { data: { text: string } }).data.text, '{"answer":42,"items":["a","b"]}');
  const huge = part("StructuredData", { value: { text: "x".repeat(70_000) } });
  assert.deepEqual(transformOutputPart(huge), { part: huge, transformation: null });
});
test("only this generation's raw-only stream artifacts are dropped; import-derived artifacts stay for the mapper's refusal", () => {
  const streamed = part("ProviderArtifact", { providerKind: "future_file_output", rawObjectId: id(), locator: "generation-stream/record/9" });
  assert.deepEqual(transformOutputPart(streamed), { part: null, transformation: "providerArtifactsDegraded" });
  const imported = part("ProviderArtifact", { providerKind: "unsupported-part", rawObjectId: id(), locator: "conversations/3/message/content" });
  assert.deepEqual(transformOutputPart(imported), { part: imported, transformation: null });
  const text = part("Text", { text: "unchanged" });
  assert.deepEqual(transformOutputPart(text), { part: text, transformation: null });
});
test("the transformations are described in the switch report wording", () => {
  assert.deepEqual(describeTransformations({ inlinedBlobText: 0, unavailableImages: 0, citationsTransformed: 2, structuredDataFlattened: 1, providerArtifactsDegraded: 3 }), [
    "2 citations sent as a plain source note because providers accept citations only with their cited documents",
    "1 structured output value sent as JSON text",
    "3 provider-specific output records omitted because no provider accepts it as input; the original is retained",
  ]);
});
