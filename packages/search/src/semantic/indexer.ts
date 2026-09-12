import type { SemanticClaim, SemanticIndexStatus, SemanticPublication, StorageClient } from "@quixi/core/contracts";

/** The injected local embedding runtime. Vectors are produced with document
 * semantics for chunks and query semantics for queries (product §53). */
export interface EmbeddingClient {
  embed(text: string, role: "query" | "document", options?: { priority?: 0 | 1 | 2 | 3 | 4; signal?: AbortSignal }): Promise<{ vector: Float32Array; route: string; cacheHit: boolean }>;
  statistics(remainingDocuments?: number): Promise<EmbeddingRuntimeStatistics>;
  pauseBackground(): Promise<void>;
  resumeBackground(): Promise<void>;
}
export interface EmbeddingRuntimeStatistics {
  state: "ready" | "running" | "switching" | "unavailable" | "closed";
  route: string;
  kind: "cpu" | "gpu";
  background: "running" | "paused" | "draining";
  recentChunksPerSecond: number | null;
  estimatedRemainingSeconds: number | null;
}
export interface SemanticIndexerOptions {
  storage: Pick<StorageClient, "request">;
  embeddings: EmbeddingClient;
  /** One claim per cycle: chunks and their exact input bytes. */
  claim?: { maxChunks: number; maxBytes: number };
  /** Concurrent inference requests in flight from one cycle. */
  concurrency?: number;
  /** Wait between empty cycles and after a transient failure. */
  idleDelayMs?: number;
  retryDelayMs?: number;
  /** A cycle whose publication is fully rejected as stale ends the loop
   * after this many repeats; the owner re-enrols explicitly. */
  maxStaleCycles?: number;
  onChange?: (snapshot: SemanticIndexerSnapshot) => void;
}
export interface SemanticIndexerSnapshot {
  state: "idle" | "indexing" | "paused" | "stopped" | "failed";
  status: SemanticIndexStatus | null;
  runtime: EmbeddingRuntimeStatistics | null;
  cycles: number;
  claimed: number;
  reused: number;
  accepted: number;
  rejected: Record<SemanticPublication["rejected"][number]["reason"], number>;
  inferenceFailures: number;
  lastError: string | null;
  /** Approximate seconds for the storage-reported pending chunks at the
   * runtime's recent throughput; null without a measured rate. */
  estimatedRemainingSeconds: number | null;
}
export interface SemanticIndexer {
  start(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Cancels in-flight inference; claimed chunks are offered again after their lease. */
  stop(): Promise<void>;
  /** New content or a resumed enrolment: end the idle wait early. */
  wake(): void;
  getSnapshot(): SemanticIndexerSnapshot;
  subscribe(listener: () => void): () => void;
}
const id = () => crypto.randomUUID();
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});
const isTransient = (error: unknown) => ["saturated", "timeout", "OVERLOADED", "CONFLICT", "cancelled"].includes(String((error as { code?: string }).code));
const isFatal = (error: unknown) => ["closed", "backend", "unavailable", "MIGRATION_FAILED", "CLOSED", "UNSUPPORTED"].includes(String((error as { code?: string }).code));

/** Product §72–74: bounded claim → embed → publish cycles. Storage decides
 * what is missing or outdated and rejects stale results; this loop never
 * writes a vector directly and never blocks lexical search. */
export function createSemanticIndexer(options: SemanticIndexerOptions): SemanticIndexer {
  const claimBounds = options.claim ?? { maxChunks: 16, maxBytes: 262_144 };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const idleDelay = options.idleDelayMs ?? 2_000, retryDelay = options.retryDelayMs ?? 5_000, maxStale = options.maxStaleCycles ?? 3;
  let snapshot: SemanticIndexerSnapshot = Object.freeze({ state: "idle", status: null, runtime: null, cycles: 0, claimed: 0, reused: 0, accepted: 0, rejected: { stale_generation: 0, model_mismatch: 0, chunk_changed: 0, invalid_vector: 0, duplicate: 0 }, inferenceFailures: 0, lastError: null, estimatedRemainingSeconds: null });
  const listeners = new Set<() => void>();
  const patch = (change: Partial<SemanticIndexerSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...change });
    for (const listener of listeners) { try { listener(); } catch { /* isolate */ } }
    try { options.onChange?.(snapshot); } catch { /* isolate */ }
  };
  let loop: Promise<void> | null = null, controller = new AbortController(), paused = false, resumeSignal: (() => void) | null = null, wakeSignal: (() => void) | null = null;
  let staleCycles = 0;
  const waitResume = () => new Promise<void>((resolve) => { resumeSignal = resolve; controller.signal.addEventListener("abort", () => resolve(), { once: true }); });
  const idle = (ms: number) => Promise.race([delay(ms, controller.signal), new Promise<void>((resolve) => { wakeSignal = resolve; })]).finally(() => { wakeSignal = null; });
  async function refresh(): Promise<SemanticIndexStatus | null> {
    try {
      const status = await options.storage.request(id(), "semanticStatus", null);
      let runtime: EmbeddingRuntimeStatistics | null = snapshot.runtime;
      try { runtime = await options.embeddings.statistics(status.pendingChunks); } catch { /* keep the last observation */ }
      const rate = runtime?.recentChunksPerSecond ?? null;
      patch({ status, runtime, estimatedRemainingSeconds: rate && rate > 0 ? Math.round(status.pendingChunks / rate) : null });
      return status;
    } catch (error) {
      patch({ lastError: (error as Error).message });
      return null;
    }
  }
  async function cycle(): Promise<"worked" | "empty" | "blocked"> {
    const claim: SemanticClaim = await options.storage.request(id(), "claimSemanticChunks", { ...claimBounds });
    if (claim.model === null) return "blocked";
    patch({ claimed: snapshot.claimed + claim.items.length, reused: snapshot.reused + claim.reused });
    if (!claim.items.length) return claim.reused ? "worked" : "empty";
    patch({ state: "indexing" });
    const vectors = new Map<string, number[]>();
    let failures = 0;
    const queue = [...claim.items];
    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item || controller.signal.aborted) return;
        try {
          const result = await options.embeddings.embed(item.text, "document", { priority: 4, signal: controller.signal });
          vectors.set(item.chunkId, Array.from(result.vector));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (isFatal(error)) throw error;
          failures++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    if (failures) patch({ inferenceFailures: snapshot.inferenceFailures + failures });
    if (controller.signal.aborted || !vectors.size) return vectors.size ? "worked" : failures ? "blocked" : "empty";
    const items = claim.items.filter((item) => vectors.has(item.chunkId)).map((item) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: vectors.get(item.chunkId)! }));
    let accepted = 0;
    const rejected = { ...snapshot.rejected }, staleBefore = snapshot.rejected.stale_generation;
    for (let at = 0; at < items.length; at += 64) {
      const publication = await options.storage.request(id(), "publishSemanticVectors", { generation: claim.generation, items: items.slice(at, at + 64) });
      accepted += publication.accepted;
      for (const entry of publication.rejected) rejected[entry.reason]++;
      patch({ status: publication.status });
    }
    patch({ accepted: snapshot.accepted + accepted, rejected });
    if (!accepted && items.length && rejected.stale_generation > staleBefore) staleCycles++;
    else staleCycles = 0;
    if (staleCycles >= maxStale) throw Object.assign(new Error("The semantic index generation changed repeatedly; restart indexing after the enrolment settles."), { code: "UNSUPPORTED" });
    return "worked";
  }
  async function run(): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        if (paused) { patch({ state: "paused" }); await waitResume(); continue; }
        let outcome: "worked" | "empty" | "blocked";
        try {
          outcome = await cycle();
          patch({ cycles: snapshot.cycles + 1, lastError: null });
        } catch (error) {
          if (controller.signal.aborted) break;
          patch({ lastError: (error as Error).message });
          if (isFatal(error) && !isTransient(error)) { patch({ state: "failed" }); return; }
          await refresh();
          await idle(retryDelay);
          continue;
        }
        await refresh();
        if (controller.signal.aborted) break;
        if (outcome === "worked") continue;
        patch({ state: "idle" });
        await idle(outcome === "blocked" ? retryDelay : idleDelay);
      }
    } finally {
      if (snapshot.state !== "failed") patch({ state: "stopped" });
    }
  }
  return {
    start() {
      if (loop) return;
      controller = new AbortController();
      patch({ state: "idle" });
      loop = run().catch((error) => { patch({ state: "failed", lastError: (error as Error).message }); }).finally(() => { loop = null; });
    },
    async pause() {
      paused = true;
      wakeSignal?.();
      try { await options.embeddings.pauseBackground(); } catch { /* runtime may already be paused or closed */ }
      if (loop) patch({ state: "paused" });
    },
    async resume() {
      paused = false;
      try { await options.embeddings.resumeBackground(); } catch { /* runtime may be closed */ }
      resumeSignal?.(); resumeSignal = null;
      wakeSignal?.();
      if (!loop) this.start();
    },
    async stop() {
      controller.abort();
      resumeSignal?.(); resumeSignal = null;
      wakeSignal?.();
      await loop;
    },
    wake() { wakeSignal?.(); },
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
