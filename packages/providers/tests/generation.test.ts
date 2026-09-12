import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { MutationBatch, StorageClient } from "@quixi/core/contracts";
import { SUMMARY_LIMITS, type ContentPart, type Generation, type Message } from "@quixi/core/model";
import { startGeneration, type GenerationRunOptions } from "../src/generation.ts";
import { emptyUsage, type ProviderAdapter, type ProviderEvent } from "../src/types.ts";
import { input, model } from "./fixtures.ts";

const completed: ProviderEvent = {
  type: "terminal", status: "complete", stopReason: "stop",
  responseId: null, usage: emptyUsage(), error: null,
};
const delta = (text: string): ProviderEvent => ({ type: "text", key: "answer", text });

/** A strict checkpoint sink tests the consumer without network or archive state.
 * Real worker persistence and restart remain covered by run-browser.mjs. */
async function consume(
  events: ProviderEvent[],
  { summary = true, rejectCancellation = false, initialThreadRevision, initialFailure, raceBeforeCreate = false, beforeDispatch, protocol = "openai-compatible", lostReceiptReply = false }: {
    summary?: boolean; rejectCancellation?: boolean; initialThreadRevision?: number;
    initialFailure?: 'unknown_before' | 'unknown_after'; raceBeforeCreate?: boolean;
    beforeDispatch?: () => Promise<void>;
    protocol?: "openai-compatible" | "anthropic"; lostReceiptReply?: boolean;
  } = {},
) {
  const id = () => crypto.randomUUID();
  const threadId = id(), parentId = id(), outputId = id(), generationId = id();
  const generation: Generation = {
    id: generationId, threadId, parentMessageId: parentId, outputMessageId: outputId,
    contextSnapshotId: id(), provider: "fixture", providerAccountId: "fixture-account",
    model: "synthetic-model", parameters: {}, status: "streaming", createdAt: 1,
    recordedAt: 1, completedAt: null, tokensIn: null, tokensOut: null,
    cachedTokens: null, estimatedCost: null, reportedCost: null, lastSequence: 0,
    rawResponseId: null, compatibility: [], ...(summary ? { purpose: "context_summary" as const } : {}),
  };
  const output: Message = {
    id: outputId, threadId, parentId, role: "assistant", createdAt: 1, recordedAt: 1,
    generationId, editedFromMessageId: null, partCount: 0, sealed: false,
  };
  let cancellations = 0, consumed = 0, iteratorClosed = false, streamStarts = 0;
  const adapter = {
    protocol,
    binding: { providerId: "fixture", accountId: "fixture-account", destinationId: "fixture", transportId: "fixture" },
    prepare: () => ({ requestId: id(), model: model("openai-compatible"), path: "/fixture", headers: {}, body: {} }),
    estimateCost: () => ({ cost: null, pricing: null, reason: "Synthetic fixture" }),
    stream: (_input: unknown, guard?: () => Promise<void>) => { streamStarts++; return ({
      events: (async function* () {
        try {
          await guard?.();
          for (const event of events) { consumed++; yield event; }
        } finally { iteratorClosed = true; }
      })(),
      cancel: async () => {
        cancellations++;
        if (rejectCancellation) throw new Error("Synthetic cancellation failure");
        return { requestId: id(), outcome: "cancelled", externalEffect: "unknown" };
      },
    }); },
  } as unknown as ProviderAdapter;
  const parts: ContentPart[] = [];
  const blobs = new Map<string, Uint8Array[]>();
  const manifests: { terminal: Extract<ProviderEvent, { type: "terminal" }> }[] = [];
  let retained: Generation | null = null;
  let sealed = false;
  const batches: MutationBatch[] = [], committedOperations = new Set<string>();
  let threadRevision = 4, injected = false;
  const storage = {
    request: async (_requestId: string, operation: string, args: any) => {
      if (operation === 'operationStatus') return { operationId: args.operationId, status: committedOperations.has(args.operationId) ? 'committed' : 'not_found' };
      if (operation === "beginBlobTransfer") {
        const transferId = id(); blobs.set(transferId, []);
        return { transferId, maxChunkBytes: 4096 };
      }
      if (operation === "finishBlobTransfer") {
        const bytes = Buffer.concat(blobs.get(args.transferId)!);
        assert.equal(bytes.length, args.expectedBytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), args.expectedSha256);
        manifests.push(JSON.parse(bytes.toString()));
        return { ...args, state: "verified_staged" };
      }
      if (operation === "discardBlobTransfer") return { discarded: blobs.delete(args.transferId) };
      assert.equal(operation, "commit");
      const batch = args as MutationBatch; batches.push(structuredClone(batch));
      const creates = batch.mutations.some(mutation => mutation.kind === 'CreateGeneration');
      if (creates && raceBeforeCreate && !injected) { await Promise.resolve(); threadRevision++; injected = true; }
      if (creates && initialFailure === 'unknown_before' && !injected) { injected = true; throw Object.assign(new Error('Initial commit reply unavailable before application'), { code: 'UNKNOWN_OUTCOME' }); }
      for (const expected of batch.expectedThreadRevisions) {
        assert.equal(expected.threadId, threadId);
        if (expected.revision !== threadRevision) throw Object.assign(new Error('Thread changed before initial creation'), { code: 'CONFLICT' });
      }
      for (const mutation of (args as MutationBatch).mutations) {
        if (mutation.kind === "CreateGeneration") retained = structuredClone(mutation.payload.generation);
        else if (mutation.kind === "AppendGenerationOutput") {
          assert.ok(retained);
          assert.equal(mutation.payload.sequence, retained.lastSequence + 1);
          retained.lastSequence++;
          for (const part of mutation.payload.newParts) {
            assert.equal(part.order, parts.length);
            parts.push(structuredClone(part));
          }
          if (mutation.payload.textAppend) {
            const part = parts.find((part) => part.id === mutation.payload.textAppend!.partId);
            assert.ok(part?.kind === "Text");
            part.data.text = (part.data.text ?? "") + mutation.payload.textAppend.text;
          }
        } else if (mutation.kind === "CompleteGeneration") {
          assert.ok(retained);
          retained.status = mutation.payload.status;
          retained.rawResponseId = mutation.payload.rawResponseId;
          sealed = true;
        } else assert.equal(mutation.kind, "RegisterRawObject");
        committedOperations.add(mutation.operationId);
      }
      threadRevision++;
      if (creates && initialFailure === 'unknown_after' && !injected) { injected = true; throw Object.assign(new Error('Initial committed reply lost'), { code: 'UNKNOWN_OUTCOME' }); }
      if (lostReceiptReply && !injected && batch.mutations.some(m => m.kind === 'AppendGenerationOutput' && m.payload.newParts.some(p => p.kind === 'ProviderArtifact' && p.data.providerKind === 'quixi.provider.anthropic-thinking-block'))) {
        injected = true; throw Object.assign(new Error('Receipt committed reply lost'), { code: 'UNKNOWN_OUTCOME' });
      }
      return {};
    },
    sendChunk: async (chunk: { transferId: string; sequence: number; offset: number; bytes: Uint8Array }) => {
      const chunks = blobs.get(chunk.transferId)!;
      assert.equal(chunk.sequence, chunks.length);
      assert.equal(chunk.offset, chunks.reduce((sum, value) => sum + value.length, 0));
      chunks.push(chunk.bytes.slice());
      return { transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length };
    },
  } as unknown as StorageClient;
  const result = await startGeneration({ adapter, input: input(), storage, attempt: { generation, output }, nextId: id, now: () => 1, ...(initialThreadRevision === undefined ? {} : { initialThreadRevision }), ...(beforeDispatch ? { beforeDispatch } : {}) }).result;
  const text = parts.map((part) => part.kind === "Text" || part.kind === "Note" ? part.data.text ?? "" : "").join("");
  return { result, retained: retained as Generation | null, sealed, text, parts, manifests, cancellations, consumed, iteratorClosed, batches, streamStarts, threadId };
}

test("summary permits exactly 16 KiB of UTF-8 and seals complete output", async () => {
  const text = "🧪".repeat(SUMMARY_LIMITS.textBytes / 4);
  const value = await consume([delta(text), completed]);
  assert.equal(value.result.persisted, true);
  assert.equal(value.retained?.status, "complete");
  assert.equal(value.text, text);
  assert.equal(value.sealed, true);
  assert.equal(value.cancellations, 0);
  assert.equal(value.manifests[0]?.terminal.status, "complete");
});

test("summary overflow cancels before appending excess text and seals the committed prefix partial", async () => {
  const prefix = "🧪".repeat(SUMMARY_LIMITS.textBytes / 4);
  const value = await consume([delta(prefix), delta("x"), delta("must not consume"), completed]);
  assert.equal(value.result.persisted, true);
  assert.equal(value.retained?.status, "partial");
  assert.equal(value.sealed, true);
  assert.equal(value.text, prefix);
  assert.equal(value.cancellations, 1);
  assert.equal(value.consumed, 2);
  assert.equal(value.iteratorClosed, true);
  assert.equal(value.result.terminal?.stopReason, "summary_text_limit");
  assert.equal(value.manifests[0]?.terminal.error?.code, "limit");
});

test("summary oversized first delta persists an empty partial attempt with a terminal manifest", async () => {
  const value = await consume([delta("🧪".repeat(SUMMARY_LIMITS.textBytes / 4 + 1)), completed]);
  assert.equal(value.result.persisted, true);
  assert.equal(value.retained?.status, "partial");
  assert.equal(value.text, "");
  assert.equal(value.sealed, true);
  assert.equal(value.cancellations, 1);
  assert.equal(value.parts.filter((part) => part.kind === "Text").length, 0);
  assert.equal(value.manifests[0]?.terminal.stopReason, "summary_text_limit");
});

test("summary counts Text and Note output parts together with streaming deltas", async () => {
  const prefix = "x".repeat(SUMMARY_LIMITS.textBytes - 4);
  const value = await consume([
    { type: "part", key: "answer", part: { kind: "Text", data: { text: prefix } } },
    { type: "part", key: "note", part: { kind: "Note", data: { text: "🧪" } } },
    delta("x"), completed,
  ]);
  assert.equal(value.result.persisted, true);
  assert.equal(value.text, prefix + "🧪");
  assert.equal(value.retained?.status, "partial");
  assert.equal(value.cancellations, 1);
});

test("summary cancellation rejection still seals the retained prefix partial", async () => {
  const value = await consume([delta("retained"), delta("x".repeat(SUMMARY_LIMITS.textBytes)), completed], { rejectCancellation: true });
  assert.equal(value.result.persisted, true);
  assert.equal(value.result.error, null);
  assert.equal(value.retained?.status, "partial");
  assert.equal(value.sealed, true);
  assert.equal(value.text, "retained");
  assert.equal(value.cancellations, 1);
});

test("ordinary chat may exceed the summary review cap and keeps its normal terminal status", async () => {
  const text = "🧪".repeat(SUMMARY_LIMITS.textBytes / 4 + 1);
  const value = await consume([delta(text), completed], { summary: false });
  assert.equal(value.result.persisted, true);
  assert.equal(value.retained?.status, "complete");
  assert.equal(value.text, text);
  assert.equal(value.cancellations, 0);
  assert.equal(value.sealed, true);
});

test('initial thread revision guards creation only while later output checkpoints survive revision changes', async () => {
  const value = await consume([delta('retained output'), completed], { initialThreadRevision: 4 });
  assert.equal(value.result.persisted, true); assert.equal(value.streamStarts, 1);
  assert.deepEqual(value.batches[0]!.expectedThreadRevisions, [{ threadId: value.threadId, revision: 4 }]);
  assert(value.batches.length > 1);
  for (const batch of value.batches.slice(1)) assert.deepEqual(batch.expectedThreadRevisions, []);
  assert.equal(value.retained?.status, 'complete');
});

test('a conversation revision race before initial commit refuses the attempt before provider dispatch', async () => {
  const value = await consume([delta('must not dispatch'), completed], { initialThreadRevision: 4, raceBeforeCreate: true });
  assert.equal(value.result.persisted, false); assert.equal(value.result.error?.code, 'CONFLICT');
  assert.equal(value.batches.length, 1); assert.equal(value.retained, null); assert.equal(value.streamStarts, 0);
  assert.equal(value.consumed, 0); assert.equal(value.parts.length, 0); assert.equal(value.manifests.length, 0);
});

test('unknown initial outcomes retain the same guarded batch or resolve its committed identity without redispatch', async () => {
  for (const initialFailure of ['unknown_before', 'unknown_after'] as const) {
    const value = await consume([delta('one stream'), completed], { initialThreadRevision: 4, initialFailure });
    assert.equal(value.result.persisted, true); assert.equal(value.streamStarts, 1);
    const creates = value.batches.filter(batch => batch.mutations.some(mutation => mutation.kind === 'CreateGeneration'));
    assert.equal(creates.length, initialFailure === 'unknown_before' ? 2 : 1);
    assert.deepEqual(creates[0]!.expectedThreadRevisions, [{ threadId: value.threadId, revision: 4 }]);
    if (creates.length === 2) assert.deepEqual(creates[1], creates[0], 'recovery must preserve transaction, operation identities and revision condition');
  }
});

test('invalid initial revisions fail before adapter preparation', () => {
  for (const initialThreadRevision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    let prepared = false;
    const options = { initialThreadRevision, adapter: { prepare() { prepared = true; throw new Error('must not prepare'); } } } as unknown as GenerationRunOptions;
    assert.throws(() => startGeneration(options), /Initial thread revision must be a nonnegative safe integer/);
    assert.equal(prepared, false);
  }
});

test('generation passes the final authorization guard to the adapter before consuming provider events', async () => {
  let checks = 0;
  const value = await consume([delta('must not consume'), completed], { beforeDispatch: async () => { checks++; throw new Error('Authorization changed'); } });
  assert.equal(checks, 1); assert.equal(value.consumed, 0); assert.equal(value.result.persisted, false);
  assert.equal(value.retained?.status, 'streaming', 'the adapter owns guard-failure terminal normalization; this strict fake rejects before events');
});

const thinkingReceipt: ProviderEvent = { type: 'reasoning_block', index: 0, startRecord: 2, endRecord: 5, block: { type: 'thinking', thinking: '\ufeffsynthetic\n🧪', signature: 'opaque+/=' } };
const thinkingPrefix: ProviderEvent[] = [
  { type: 'metadata', responseId: 'synthetic-response', model: 'synthetic-model', headers: {} },
  { type: 'raw', sequence: 0, bytes: new TextEncoder().encode('{"syntheticRaw":true}') },
];
test('closed reasoning receipt is a verified blob atomically referenced by canonical output, including lost reply', async () => {
  const value = await consume([...thinkingPrefix, thinkingReceipt, completed], { summary: false, protocol: 'anthropic', lostReceiptReply: true });
  assert.equal(value.result.persisted, true);
  const receipts = value.parts.filter(p => p.kind === 'ProviderArtifact' && p.data.providerKind === 'quixi.provider.anthropic-thinking-block');
  assert.equal(receipts.length, 1);
  const receipt = value.manifests[1] as unknown as Record<string, any>;
  assert.deepEqual(receipt.block, thinkingReceipt.block);
  assert.equal(receipt.generationId, value.retained!.id);
  assert.equal(receipt.outputMessageId, value.retained!.outputMessageId);
  assert.equal(receipt.responseId, 'synthetic-response');
  assert.deepEqual(receipt.source, { startRecord: 2, endRecord: 5, rawSegmentsThroughCheckpoint: 1, rawBytesThroughCheckpoint: 21 });
  const batch = value.batches.find(b => b.mutations.some(m => m.kind === 'AppendGenerationOutput' && m.payload.newParts.some(p => p.id === receipts[0]!.id)))!;
  assert.equal(batch.stagedBlobIds.length, 1);
  assert.equal(batch.mutations.filter(m => m.kind === 'RegisterRawObject').length, 1);
});
test('receipt persistence refuses wrong protocol, absent source, duplicate index and oversized content', async () => {
  for (const [events, protocol] of [
    [[...thinkingPrefix, thinkingReceipt], 'openai-compatible'],
    [[thinkingReceipt], 'anthropic'],
    [[...thinkingPrefix, thinkingReceipt, thinkingReceipt], 'anthropic'],
    [[...thinkingPrefix, { ...thinkingReceipt, block: { type: 'thinking', thinking: 'x'.repeat(262144), signature: 'opaque' } }], 'anthropic'],
  ] as [ProviderEvent[], 'anthropic' | 'openai-compatible'][]) {
    const value = await consume([...events, completed], { summary: false, protocol });
    assert.equal(value.result.persisted, false);
    assert.match(value.result.error!.message, /thinking block receipt/);
  }
});
