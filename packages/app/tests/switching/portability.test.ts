import test from "node:test";
import assert from "node:assert/strict";
import type { CompatibilityReport } from "@quixi/providers";
import {
  describePortability,
  type PortabilityTarget,
} from "../../src/runtime/portability.ts";

const report = (overrides: Partial<CompatibilityReport> = {}): CompatibilityReport => ({
  target: { protocol: "anthropic", modelId: "m" },
  preserved: { parts: 4, byKind: { Text: 4 } },
  blocked: [],
  constraints: [],
  requestBytes: 900,
  sendable: true,
  context: { contextWindow: 8_192, maxOutputTokens: 1_024, inputRoom: 7_168 },
  pricing: null,
  ...overrides,
});
const anthropic = (overrides: Partial<CompatibilityReport> = {}): PortabilityTarget => ({
  provider: { id: "anthropic", label: "Anthropic" },
  model: { id: "claude", name: "Claude Haiku 4.5" },
  report: report(overrides),
});
const openai = (overrides: Partial<CompatibilityReport> = {}): PortabilityTarget => ({
  provider: { id: "openai", label: "OpenAI" },
  model: { id: "gpt", name: "GPT-4.1 mini" },
  report: report({ target: { protocol: "openai-compatible", modelId: "gpt" }, ...overrides }),
});
const blockedReasoning = (): Partial<CompatibilityReport> => ({
  preserved: { parts: 3, byKind: { Text: 3 } },
  blocked: [
    { partId: "p1", kind: "ReasoningMetadata", code: "content_mapping", message: "Explicit compatibility handling is required for ReasoningMetadata." },
  ],
  sendable: false,
});
const none = { internalProvenance: 0, emptyAssistant: 0 };
const unchanged = { inlinedBlobText: 0, unavailableImages: 0 };

test("every target carrying every part is fully portable, with one reason per target", () => {
  const assessment = describePortability([anthropic(), openai()], unchanged, { internalProvenance: 6, emptyAssistant: 1 });
  assert.equal(assessment.status, "fully_portable");
  assert.equal(assessment.label, "Fully portable");
  assert.equal(assessment.summary, "Every configured target can carry all 4 parts of the active path.");
  assert.deepEqual(assessment.reasons, [
    "Anthropic · Claude Haiku 4.5: carries all 4 parts.",
    "OpenAI · GPT-4.1 mini: carries all 4 parts.",
    "6 internal provider records and 1 empty response are never sent to any provider.",
  ]);
});

test("inlined long text or images without local bytes make the path portable with transformations", () => {
  const assessment = describePortability([anthropic(), openai()], { inlinedBlobText: 2, unavailableImages: 0 }, none);
  assert.equal(assessment.status, "portable_with_transformations");
  assert.match(assessment.summary, /2 long text parts sent inline from stored bytes/);
  assert.equal(assessment.reasons[0], "Anthropic · Claude Haiku 4.5: carries all 4 parts; 2 long text parts sent inline from stored bytes.");
  const images = describePortability([anthropic()], { inlinedBlobText: 1, unavailableImages: 1 }, none);
  assert.equal(images.status, "portable_with_transformations");
  assert.equal(
    images.summary,
    "Every configured target can carry the active path; 1 long text part sent inline from stored bytes; 1 image without local bytes sent as a note naming the missing file.",
  );
});

test("a path some targets refuse is provider-dependent and names each refusal", () => {
  const assessment = describePortability(
    [
      anthropic(),
      openai({
        preserved: { parts: 3, byKind: { Text: 3 } },
        blocked: [
          { partId: "p1", kind: "ToolCall", code: "content_mapping", message: "x" },
          { partId: "p2", kind: "ToolCall", code: "content_mapping", message: "y" },
          { partId: "p3", kind: "Image", code: "images_unsupported", message: "z" },
        ],
        sendable: false,
      }),
    ],
    unchanged,
    none,
  );
  assert.equal(assessment.status, "provider_dependent");
  assert.equal(assessment.summary, "1 target of 2 can carry the active path.");
  assert.equal(assessment.reasons[1], "OpenAI · GPT-4.1 mini: blocked — 2 ToolCall parts (content_mapping); 1 Image part (images_unsupported)");
});

test("a path no target can carry is blocked, and constraints are quoted", () => {
  const assessment = describePortability(
    [
      anthropic(blockedReasoning()),
      openai({
        ...blockedReasoning(),
        constraints: [{ messageIndex: null, partId: null, code: "system_unsupported", message: "This model accepts no system prompt." }],
      }),
    ],
    unchanged,
    none,
  );
  assert.equal(assessment.status, "blocked");
  assert.equal(assessment.summary, "None of the 2 configured targets can carry the active path.");
  assert.equal(assessment.reasons[0], "Anthropic · Claude Haiku 4.5: blocked — 1 ReasoningMetadata part (content_mapping)");
  assert.equal(assessment.reasons[1], "OpenAI · GPT-4.1 mini: blocked — 1 ReasoningMetadata part (content_mapping); This model accepts no system prompt.");
});

test("without a configured target the status is unknown with an explicit reason", () => {
  const assessment = describePortability([], unchanged, { internalProvenance: 2, emptyAssistant: 0 });
  assert.equal(assessment.status, "unknown");
  assert.equal(assessment.summary, "No connection is configured, so no target was analysed.");
  assert.deepEqual(assessment.reasons, [
    "Connect a provider to assess where this conversation can continue.",
    "2 internal provider records and 0 empty responses are never sent to any provider.",
  ]);
});


test("a reviewed summary is reported as a transformation with retained source history", () => {
  const assessment = describePortability([anthropic(), openai()], { ...unchanged, reviewedSummary: true, excludedAttachments: 1 }, none);
  assert.equal(assessment.status, "portable_with_transformations");
  assert.match(assessment.summary, /older conversation replaced with its user-reviewed summary; source history is retained/);
  assert.match(assessment.summary, /1 attachment occurrence replaced/);
  assert(assessment.reasons.every(reason => reason.includes("user-reviewed summary")));
});
