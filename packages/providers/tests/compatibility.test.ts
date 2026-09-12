import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCompatibility, prepare } from "../src/request.ts";
import { CompatibilityError, type ProviderInput } from "../src/index.ts";
import { model, input } from "./fixtures.ts";

const part = (messageId: string, order: number, kind: string, data: unknown) =>
  ({ id: crypto.randomUUID(), messageId, order, kind, data }) as ProviderInput["messages"][number]["parts"][number];

test("a clean path reports every part preserved by kind and the encoded request size", () => {
  const report = analyzeCompatibility("anthropic", input(), model("anthropic"));
  assert.equal(report.sendable, true);
  assert.equal(report.blocked.length, 0);
  assert.equal(report.constraints.length, 0);
  assert.ok(report.preserved.parts >= 1);
  assert.equal(report.preserved.byKind.Text, report.preserved.parts);
  assert.ok((report.requestBytes ?? 0) > 0);
  assert.deepEqual(report.target, { protocol: "anthropic", modelId: "synthetic-model" });
  assert.deepEqual(report.context, {
    contextWindow: 8192,
    maxOutputTokens: input().parameters.maxOutputTokens,
    inputRoom: 8192 - input().parameters.maxOutputTokens,
  });
  assert.deepEqual(report.pricing, model("anthropic").pricing);
});

test("refused parts are listed by kind with the mapper's own reason, and prepare refuses the same path", () => {
  const base = input();
  const messageId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const withParts: ProviderInput = {
    ...base,
    messages: [
      {
        role: "user",
        parts: [
          part(messageId, 0, "Text", { text: "Keep this" }),
          part(messageId, 1, "Image", { attachmentId, description: null }),
          part(messageId, 2, "File", { attachmentId, description: null }),
          part(messageId, 3, "ReasoningMetadata", { redacted: true, summary: null }),
        ],
      },
    ],
  };
  const report = analyzeCompatibility("openai-compatible", withParts, model("openai-compatible"));
  assert.equal(report.sendable, false);
  assert.equal(report.preserved.parts, 1);
  assert.deepEqual(report.blocked.map((item) => [item.kind, item.code]), [
    ["Image", "images_unsupported"],
    ["File", "files_unsupported"],
    ["ReasoningMetadata", "reasoning_unsupported"],
  ]);
  assert.throws(() => prepare("openai-compatible", withParts, model("openai-compatible")), CompatibilityError);
});

test("request-level constraints and an unregistered model are reported without throwing", () => {
  const unregistered = analyzeCompatibility("anthropic", input(), null);
  assert.equal(unregistered.sendable, false);
  assert.deepEqual(unregistered.blocked, []);
  assert.equal(unregistered.constraints[0]?.code, "model_catalog_required");
  assert.equal(unregistered.requestBytes, null);
  assert.deepEqual(unregistered.context, {
    contextWindow: null,
    maxOutputTokens: input().parameters.maxOutputTokens,
    inputRoom: null,
  });
  assert.equal(unregistered.pricing, null);
  const withSystem: ProviderInput = { ...input(), systemPrompt: "Be brief" };
  const noSystem = analyzeCompatibility(
    "anthropic",
    withSystem,
    { ...model("anthropic"), capabilities: { ...model("anthropic").capabilities, systemPromptMode: "unsupported" } },
  );
  assert.equal(noSystem.sendable, false);
  assert.ok(noSystem.constraints.some((issue) => issue.code === "system_unsupported"));
  assert.ok(noSystem.preserved.parts >= 1, "the mapped parts are still counted beside the constraint");
});

test("citations, structured output and provider artifacts are refused by name on both protocols", () => {
  const messageId = crypto.randomUUID();
  const withParts: ProviderInput = {
    ...input(),
    messages: [
      { role: "user", parts: [part(messageId, 0, "Text", { text: "Question" })] },
      {
        role: "assistant",
        parts: [
          part(messageId, 0, "Text", { text: "Answer" }),
          part(messageId, 1, "Citation", { url: "https://example.invalid/source", label: "Synthetic", sourcePartId: null }),
          part(messageId, 2, "StructuredData", { value: { type: "provider_refusal" } }),
          part(messageId, 3, "ProviderArtifact", { providerKind: "future_file_output", rawObjectId: crypto.randomUUID(), locator: "generation-stream/record/9" }),
        ],
      },
    ],
  };
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    const report = analyzeCompatibility(protocol, withParts, model(protocol));
    assert.equal(report.sendable, false);
    assert.equal(report.preserved.parts, 2);
    assert.deepEqual(report.blocked.map((item) => [item.kind, item.code]), [
      ["Citation", "citation_unsupported"],
      ["StructuredData", "structured_data_unsupported"],
      ["ProviderArtifact", "provider_artifact_unsupported"],
    ]);
  }
});
