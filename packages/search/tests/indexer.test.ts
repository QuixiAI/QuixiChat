import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSemanticIndexer } from "../src/semantic/indexer.ts";
import type { EmbeddingClient, EmbeddingRuntimeStatistics } from "../src/semantic/indexer.ts";
import type { EmbeddingModelIdentity, SemanticClaim, SemanticIndexStatus, SemanticPublication, StorageOperations } from "@quixi/core/contracts";

const identity: EmbeddingModelIdentity = { modelName: "m", modelVersion: "v", sourceHash: "a".repeat(64), dimensions: 384, tokenizerVersion: "t", preprocessingVersion: "p", chunkingVersion: "c", storageRepresentation: "float32" };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const unit = () => { const v = new Float32Array(384); v[0] = 1; return v; };
/** In-memory model of the storage semantic boundary: leases, generations and
 * digest checks behave like the worker so the loop's contract is exercised. */
function fakeStorage(texts: string[], leaseMs = 30) {
  const chunks = texts.map((text, index) => ({ chunkId: index.toString(16).padStart(64, "0"), text, digest: digest(text), vector: false, leased: 0 }));
  const state = { generation: 1, state: "enrolled" as SemanticIndexStatus["state"], claims: 0, publishes: 0 };
  const status = (): SemanticIndexStatus => ({ state: state.state, model: identity, generation: state.generation, indexedChunks: chunks.filter((c) => c.vector).length, pendingChunks: chunks.filter((c) => !c.vector).length, vectors: chunks.filter((c) => c.vector).length, vectorBytes: 0 });
  return {
    state, chunks,
    async request<K extends keyof StorageOperations>(_id: string, operation: K, args: StorageOperations[K]["args"]): Promise<StorageOperations[K]["result"]> {
      if (operation === "semanticStatus") return status() as never;
      if (operation === "claimSemanticChunks") {
        state.claims++;
        const bounds = args as { maxChunks: number; maxBytes: number };
        const items: SemanticClaim["items"] = [];
        if (state.state === "enrolled") for (const chunk of chunks) {
          if (chunk.vector || Date.now() - chunk.leased < leaseMs || items.length >= bounds.maxChunks) continue;
          chunk.leased = Date.now();
          items.push({ chunkId: chunk.chunkId, textDigest: chunk.digest, text: chunk.text });
        }
        return { generation: state.generation, model: identity, items, reused: 0 } as never;
      }
      if (operation === "publishSemanticVectors") {
        state.publishes++;
        const { generation, items } = args as { generation: number; items: { chunkId: string; textDigest: string; vector: number[] }[] };
        const rejected: SemanticPublication["rejected"] = [];
        let accepted = 0;
        for (const item of items) {
          const chunk = chunks.find((c) => c.chunkId === item.chunkId);
          if (generation !== state.generation) rejected.push({ chunkId: item.chunkId, reason: "stale_generation" });
          else if (!chunk || chunk.digest !== item.textDigest) rejected.push({ chunkId: item.chunkId, reason: "chunk_changed" });
          else if (chunk.vector) rejected.push({ chunkId: item.chunkId, reason: "duplicate" });
          else { chunk.vector = true; chunk.leased = 0; accepted++; }
        }
        return { accepted, rejected, status: status() } as never;
      }
      throw new Error(`unexpected ${operation}`);
    },
  };
}
function fakeEmbeddings(options: { failFor?: (text: string) => Error | null; delayMs?: number } = {}) {
  const calls: string[] = [];
  let paused = false;
  const statistics: EmbeddingRuntimeStatistics = { state: "ready", route: "wasm-simd-fp32", kind: "cpu", background: "running", recentChunksPerSecond: 10, estimatedRemainingSeconds: null };
  const client: EmbeddingClient = {
    async embed(text, role, embedOptions) {
      assert.equal(role, "document");
      assert.equal(embedOptions?.priority, 4);
      calls.push(text);
      if (options.delayMs) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        embedOptions?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); }, { once: true });
      });
      const failure = options.failFor?.(text);
      if (failure) throw failure;
      return { vector: unit(), route: statistics.route, cacheHit: false };
    },
    async statistics() { return { ...statistics, background: paused ? "paused" : "running" }; },
    async pauseBackground() { paused = true; },
    async resumeBackground() { paused = false; },
  };
  return { client, calls, isPaused: () => paused };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const running: { stop(): Promise<void> }[] = [];
const track = <T extends { stop(): Promise<void> }>(indexer: T): T => { running.push(indexer); return indexer; };
test.afterEach(async () => { for (const indexer of running.splice(0)) await indexer.stop(); });
async function until(check: () => boolean, ms = 2_000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > ms) throw new Error("condition not met"); await settle(); }
}

test("bounded cycles claim, embed and publish until storage reports nothing pending, then idle", async () => {
  const storage = fakeStorage(Array.from({ length: 40 }, (_, n) => `chunk ${n}`));
  const embeddings = fakeEmbeddings();
  const indexer = track(createSemanticIndexer({ storage, embeddings: embeddings.client, claim: { maxChunks: 16, maxBytes: 65536 }, idleDelayMs: 50 }));
  indexer.start();
  await until(() => indexer.getSnapshot().status?.pendingChunks === 0 && indexer.getSnapshot().state === "idle");
  const snapshot = indexer.getSnapshot();
  assert.equal(snapshot.accepted, 40);
  assert.equal(snapshot.claimed, 40);
  assert.equal(embeddings.calls.length, 40);
  assert.ok(storage.state.claims >= 3, "claims are bounded to 16 chunks each");
  assert.equal(snapshot.rejected.stale_generation, 0);
  assert.equal(snapshot.estimatedRemainingSeconds, 0);
  await indexer.stop();
  assert.equal(indexer.getSnapshot().state, "stopped");
});

test("stale results are rejected by storage and counted; repeated stale cycles stop the loop explicitly", async () => {
  const storage = fakeStorage(["a", "b", "c"]);
  const embeddings = fakeEmbeddings();
  // Every publication arrives after the generation moved on (a re-enrolment
  // racing the loop): nothing enters the index and the loop ends with a reason.
  const original = storage.request.bind(storage);
  storage.request = (async (id: string, operation: never, args: never) => {
    if (operation === "publishSemanticVectors") storage.state.generation++;
    return original(id, operation, args);
  }) as typeof storage.request;
  const indexer = track(createSemanticIndexer({ storage, embeddings: embeddings.client, idleDelayMs: 10, retryDelayMs: 10, maxStaleCycles: 2 }));
  indexer.start();
  await until(() => indexer.getSnapshot().state === "failed");
  const snapshot = indexer.getSnapshot();
  assert.ok(snapshot.rejected.stale_generation >= 2);
  assert.equal(snapshot.accepted, 0);
  assert.match(snapshot.lastError ?? "", /generation changed/);
  assert.ok(storage.chunks.every((chunk) => !chunk.vector), "no stale vector entered the index");
  await indexer.stop();
});

test("pause stops claims and background inference; resume continues only what is missing", async () => {
  const storage = fakeStorage(Array.from({ length: 6 }, (_, n) => `p${n}`));
  const embeddings = fakeEmbeddings({ delayMs: 15 });
  const indexer = track(createSemanticIndexer({ storage, embeddings: embeddings.client, claim: { maxChunks: 2, maxBytes: 65536 }, idleDelayMs: 20 }));
  indexer.start();
  await until(() => indexer.getSnapshot().accepted >= 2);
  await indexer.pause();
  assert.ok(embeddings.isPaused());
  await until(() => indexer.getSnapshot().state === "paused");
  const claimsWhilePaused = storage.state.claims, acceptedWhilePaused = indexer.getSnapshot().accepted;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(storage.state.claims, claimsWhilePaused, "no claims while paused");
  await indexer.resume();
  assert.ok(!embeddings.isPaused());
  await until(() => indexer.getSnapshot().status?.pendingChunks === 0);
  assert.equal(indexer.getSnapshot().accepted, 6);
  assert.ok(indexer.getSnapshot().accepted > acceptedWhilePaused);
  assert.equal(embeddings.calls.length, 6, "each chunk is embedded once");
  await indexer.stop();
});

test("stop cancels in-flight inference; transient inference failures retry without publishing partial vectors", async () => {
  const storage = fakeStorage(["x", "y", "z"]);
  let flaky = true;
  const embeddings = fakeEmbeddings({ failFor: (text) => text === "y" && flaky ? Object.assign(new Error("busy"), { code: "saturated" }) : null, delayMs: 5 });
  const indexer = track(createSemanticIndexer({ storage, embeddings: embeddings.client, idleDelayMs: 10, retryDelayMs: 10 }));
  indexer.start();
  await until(() => indexer.getSnapshot().accepted === 2);
  assert.equal(indexer.getSnapshot().inferenceFailures, 1);
  assert.ok(storage.chunks.filter((c) => c.vector).length === 2);
  flaky = false;
  await until(() => indexer.getSnapshot().accepted === 3, 6_000);
  await indexer.stop();
  const slow = fakeStorage(["long"]);
  const slowEmbeddings = fakeEmbeddings({ delayMs: 500 });
  const cancelled = track(createSemanticIndexer({ storage: slow, embeddings: slowEmbeddings.client, idleDelayMs: 10 }));
  cancelled.start();
  await until(() => slowEmbeddings.calls.length === 1);
  const started = Date.now();
  await cancelled.stop();
  assert.ok(Date.now() - started < 400, "stop does not wait for the slow dispatch");
  assert.equal(slow.state.publishes, 0);
  assert.equal(cancelled.getSnapshot().state, "stopped");
});

test("a closed runtime fails the loop without touching storage again", async () => {
  const storage = fakeStorage(["a"]);
  const embeddings = fakeEmbeddings({ failFor: () => Object.assign(new Error("worker gone"), { code: "closed" }) });
  const indexer = track(createSemanticIndexer({ storage, embeddings: embeddings.client, idleDelayMs: 10, retryDelayMs: 10 }));
  indexer.start();
  await until(() => indexer.getSnapshot().state === "failed");
  assert.equal(storage.state.publishes, 0);
  assert.match(indexer.getSnapshot().lastError ?? "", /worker gone/);
  await indexer.stop();
});
