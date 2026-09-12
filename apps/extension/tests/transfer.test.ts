import test from "node:test";
import assert from "node:assert/strict";
import { runTransfer } from "../src/transfer.ts";
import type { SenderChannel } from "../src/transfer.ts";
import type { PageToExtensionMessage, ProviderImportBundle } from "@quixi/core/contracts";

const offerId = "00000000-0000-4000-8000-000000000001";
const bundle: ProviderImportBundle = { version: 1, bundleId: "00000000-0000-4000-8000-000000000002", provider: "openai", method: "extension", extractor: { name: "test", version: "1", source: "official_export" }, sourceFormatVersion: "chatgpt-official-export", capturedAt: 1, file: { name: "conversations.json", mediaType: "application/json", byteLength: 10, sha256: "a".repeat(64) }, discovered: { conversations: 1, attachments: 0, unavailableAttachments: 0 }, sourceUrl: null, checkpoint: null };
const source = (bytes: Uint8Array) => ({ byteLength: bytes.byteLength, read: async (start: number, end: number) => bytes.slice(start, end) });
/** A scripted page: records what the sender posts and replies as the bridge would. */
function fakePage(options: { maxChunkBytes: number; maxInFlight: number; dropAfterChunk?: number; ackDelayMs?: number }) {
  const sent: Record<string, unknown>[] = [];
  let listeners: ((message: PageToExtensionMessage) => void)[] = [], disconnects: (() => void)[] = [];
  let committed = 0, received: Uint8Array[] = [], dropped = false, droppedOnce = false;
  type Reply = PageToExtensionMessage extends infer M ? M extends unknown ? Omit<M, "channel" | "version"> : never : never;
  const reply = (message: Reply) => { for (const listener of listeners) listener({ channel: "quixi-extension-import", version: 1, ...message } as PageToExtensionMessage); };
  const channel = (): SenderChannel => ({
    send(message) {
      if (dropped) return;
      sent.push(message);
      if (message.kind === "offer") reply({ kind: "accepted", offerId, maxChunkBytes: options.maxChunkBytes, maxInFlight: options.maxInFlight, committedOffset: committed });
      if (message.kind === "resume") reply({ kind: "accepted", offerId, maxChunkBytes: options.maxChunkBytes, maxInFlight: options.maxInFlight, committedOffset: committed });
      if (message.kind === "chunk") {
        const chunk = message as { sequence: number; offset: number; bytesBase64: Uint8Array; final: boolean };
        if (options.dropAfterChunk !== undefined && chunk.sequence >= options.dropAfterChunk && !droppedOnce) { dropped = true; droppedOnce = true; for (const fn of disconnects) fn(); return; }
        if (chunk.offset !== committed) { reply({ kind: "ack", offerId, sequence: -1, committedOffset: committed }); return; }
        received.push(chunk.bytesBase64); committed += chunk.bytesBase64.byteLength;
        const finish = () => { reply({ kind: "ack", offerId, sequence: chunk.sequence, committedOffset: committed }); if (chunk.final) { reply({ kind: "staged", offerId }); reply({ kind: "imported", offerId, runId: "00000000-0000-4000-8000-000000000003", outcome: "complete", reason: null }); } };
        if (options.ackDelayMs) setTimeout(finish, options.ackDelayMs); else queueMicrotask(finish);
      }
    },
    onMessage(listener) { listeners.push(listener); return () => { listeners = listeners.filter((entry) => entry !== listener); }; },
    onDisconnect(listener) { disconnects.push(listener); return () => { disconnects = disconnects.filter((entry) => entry !== listener); }; },
  });
  return { channel, sent, bytes: () => { const out = new Uint8Array(committed); let at = 0; for (const part of received) { out.set(part, at); at += part.byteLength; } return out; }, reconnect() { dropped = false; listeners = []; disconnects = []; return channel(); } };
}
const identity = (bytes: Uint8Array) => bytes;

test("chunks respect the page's chunk size and in-flight window, and the import outcome ends the transfer", async () => {
  const data = new Uint8Array(1000).map((_, i) => i % 251);
  const page = fakePage({ maxChunkBytes: 128, maxInFlight: 2, ackDelayMs: 2 });
  const states: string[] = [];
  const transfer = runTransfer({ channel: page.channel(), bundle: { ...bundle, file: { ...bundle.file, byteLength: data.byteLength } }, source: source(data), pairingCode: "123456", offerId, encode: identity, onProgress: (progress) => states.push(progress.state) });
  const outcome = await transfer.done;
  assert.equal(outcome.state, "imported");
  assert.equal(outcome.outcome, "complete");
  assert.equal(outcome.runId, "00000000-0000-4000-8000-000000000003");
  const chunks = page.sent.filter((message) => message.kind === "chunk") as { offset: number; final: boolean; bytesBase64: Uint8Array }[];
  assert.equal(chunks.length, Math.ceil(1000 / 128));
  assert.ok(chunks.every((chunk) => chunk.bytesBase64.byteLength <= 128));
  assert.deepEqual(page.bytes(), data);
  assert.ok(states.includes("sending") && states.includes("staged"));
  assert.equal(page.sent[0]!.kind, "offer");
});

test("a lost connection resumes from the page's committed offset without duplicating acknowledged bytes", async () => {
  const data = new Uint8Array(600).map((_, i) => (i * 7) % 256);
  const page = fakePage({ maxChunkBytes: 100, maxInFlight: 1, dropAfterChunk: 3 });
  const transfer = runTransfer({ channel: page.channel(), bundle: { ...bundle, file: { ...bundle.file, byteLength: data.byteLength } }, source: source(data), pairingCode: "123456", offerId, encode: identity });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.bytes().byteLength, 300, "three chunks were committed before the drop");
  transfer.reconnect(page.reconnect());
  const outcome = await transfer.done;
  assert.equal(outcome.state, "imported");
  assert.deepEqual(page.bytes(), data);
  const resumes = page.sent.filter((message) => message.kind === "resume");
  assert.equal(resumes.length, 1);
});

test("cancel tells the page and ends the transfer; a rejection ends it with the page's reason", async () => {
  const data = new Uint8Array(50);
  const page = fakePage({ maxChunkBytes: 10, maxInFlight: 1, ackDelayMs: 50 });
  const transfer = runTransfer({ channel: page.channel(), bundle: { ...bundle, file: { ...bundle.file, byteLength: 50 } }, source: source(data), pairingCode: "123456", offerId, encode: identity });
  transfer.cancel("User pressed cancel");
  const outcome = await transfer.done;
  assert.equal(outcome.state, "cancelled");
  assert.ok(page.sent.some((message) => message.kind === "cancel"));
  let reject!: (message: PageToExtensionMessage) => void;
  const rejecting: SenderChannel = { send() {}, onMessage(listener) { reject = listener; return () => {}; }, onDisconnect() { return () => {}; } };
  const second = runTransfer({ channel: rejecting, bundle, source: source(new Uint8Array(10)), pairingCode: "000000", offerId, encode: identity });
  reject({ channel: "quixi-extension-import", version: 1, kind: "rejected", offerId, reason: "wrong code" });
  assert.equal((await second.done).reason, "wrong code");
});
