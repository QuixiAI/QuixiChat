import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION_IMPORT_LIMITS, generatePairingCode, parseExtensionToPageMessage, parsePageToExtensionMessage, samePairingCode, validateProviderImportBundle } from "../src/contracts/index.ts";
import type { ProviderImportBundle } from "../src/contracts/index.ts";

const bundle: ProviderImportBundle = { version: 1, bundleId: "00000000-0000-4000-8000-000000000001", provider: "openai", method: "extension", extractor: { name: "quixi-chatgpt-web", version: "0.1.0", source: "page_extraction" }, sourceFormatVersion: "chatgpt-web-conversation-observed-2026-v1", capturedAt: 1, file: { name: "chatgpt-web.json", mediaType: "application/json", byteLength: 42, sha256: "b".repeat(64) }, discovered: { conversations: 3, attachments: 1, unavailableAttachments: 1 }, sourceUrl: "https://chatgpt.com", checkpoint: { cursor: null, sinceUpdateTime: 1700000000 } };
const tag = { channel: "quixi-extension-import", version: 1, offerId: "00000000-0000-4000-8000-000000000009" };

test("bundle envelopes are validated field by field and bounded", () => {
  assert.ok(validateProviderImportBundle(bundle));
  assert.ok(!validateProviderImportBundle({ ...bundle, method: "file_export" }));
  assert.ok(!validateProviderImportBundle({ ...bundle, provider: "gemini" }));
  assert.ok(!validateProviderImportBundle({ ...bundle, file: { ...bundle.file, name: "../escape.json" } }));
  assert.ok(!validateProviderImportBundle({ ...bundle, file: { ...bundle.file, sha256: "zz" } }));
  assert.ok(!validateProviderImportBundle({ ...bundle, file: { ...bundle.file, byteLength: 0 } }));
  assert.ok(!validateProviderImportBundle({ ...bundle, discovered: { conversations: -1, attachments: 0, unavailableAttachments: 0 } }));
  assert.ok(!validateProviderImportBundle({ ...bundle, checkpoint: { cursor: 5, sinceUpdateTime: null } }));
  assert.ok(!validateProviderImportBundle({ ...bundle, extractor: { name: "x".repeat(65), version: "1", source: "page_extraction" } }));
});

test("inbound and outbound messages parse structurally; unknown or oversized shapes are dropped", () => {
  assert.ok(parseExtensionToPageMessage({ ...tag, kind: "offer", pairingCode: "123456", bundle }));
  assert.equal(parseExtensionToPageMessage({ ...tag, kind: "offer", pairingCode: "123456", bundle: { ...bundle, version: 2 } }), null);
  assert.ok(parseExtensionToPageMessage({ ...tag, kind: "chunk", sequence: 0, offset: 0, bytes: new ArrayBuffer(8), final: true }));
  assert.equal(parseExtensionToPageMessage({ ...tag, kind: "chunk", sequence: 0, offset: 0, bytes: new ArrayBuffer(EXTENSION_IMPORT_LIMITS.maxChunkBytes + 1), final: true }), null);
  assert.equal(parseExtensionToPageMessage({ ...tag, kind: "chunk", sequence: 0, offset: 0, bytes: [1, 2], final: true }), null);
  assert.equal(parseExtensionToPageMessage({ ...tag, version: 2, kind: "cancel", reason: "x" }), null);
  assert.equal(parseExtensionToPageMessage({ ...tag, kind: "accepted", maxChunkBytes: 1, maxInFlight: 1, committedOffset: 0 }), null, "page→extension kinds are not accepted inbound");
  assert.ok(parsePageToExtensionMessage({ ...tag, kind: "accepted", maxChunkBytes: 1024, maxInFlight: 2, committedOffset: 0 }));
  assert.ok(parsePageToExtensionMessage({ ...tag, kind: "imported", runId: null, outcome: "failed", reason: "quota" }));
  assert.equal(parsePageToExtensionMessage({ ...tag, kind: "imported", runId: "not-an-id", outcome: "complete", reason: null }), null);
  assert.equal(parsePageToExtensionMessage({ ...tag, kind: "offer", pairingCode: "1", bundle }), null);
});

test("pairing codes are six digits and compared in full", () => {
  const code = generatePairingCode((bytes) => { bytes.set([0, 9, 10, 255, 42, 100]); });
  assert.equal(code, "090520");
  assert.ok(samePairingCode(code, "090520"));
  assert.ok(!samePairingCode(code, "090521"));
  assert.ok(!samePairingCode(code, "09052"));
  assert.match(generatePairingCode(), /^\d{6}$/);
});
