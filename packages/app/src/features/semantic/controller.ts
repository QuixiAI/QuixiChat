import type { SemanticIndexStatus, StorageClient } from "@quixi/core/contracts";
import { createSemanticIndexer } from "@quixi/search";
import type { SemanticIndexer, SemanticIndexerSnapshot } from "@quixi/search";
import { createEmbeddingService, createEmbeddingWorker, EmbeddingServiceError } from "@quixi/quixi-embed/service";
import type { EmbeddingBackendReport, EmbeddingService } from "@quixi/quixi-embed/service";
import { embeddingAssets, embeddingModelIdentity } from "./assets.ts";
import type { EmbeddingHostOptions } from "./assets.ts";
import { describeStorageError } from "../../runtime/storage-error.ts";

export interface SemanticSnapshot {
  /** Storage's durable view: enrolment, generation, indexed/pending counts. */
  status: SemanticIndexStatus | null;
  /** The local inference runtime for this session. */
  runtime: "no-host-assets" | "not-loaded" | "loading" | "ready" | "failed";
  report: EmbeddingBackendReport | null;
  indexer: SemanticIndexerSnapshot | null;
  /** Live scheduler throughput while the runtime is loaded. */
  chunksPerSecond: number | null;
  estimatedRemainingSeconds: number | null;
  busy: boolean;
  error: string | null;
  /** Whether a query can be embedded right now, and why not. */
  query: { available: boolean; reason: string | null };
}
export interface SemanticControllerServices {
  storage: StorageClient;
  embedding?: EmbeddingHostOptions | undefined;
}
const id = () => crypto.randomUUID();
const describe = (error: unknown) => error instanceof EmbeddingServiceError ? error.message : describeStorageError(error);

/** Product §72–§74 controls over the storage boundary and the owned runtime.
 * Lexical search never waits on anything here. */
export function createSemanticController(services: SemanticControllerServices) {
  let state: SemanticSnapshot = Object.freeze({ status: null, runtime: services.embedding ? "not-loaded" : "no-host-assets", report: null, indexer: null, chunksPerSecond: null, estimatedRemainingSeconds: null, busy: false, error: null, query: { available: false, reason: "Semantic search is not enabled." } });
  const listeners = new Set<() => void>();
  let service: EmbeddingService | null = null, loading: Promise<EmbeddingService> | null = null, indexer: SemanticIndexer | null = null;
  // One parked worker per controller lifetime (see createEmbeddingWorker).
  let worker: Worker | null = null;
  let disposed = false, unsubscribeStatistics: (() => void) | null = null;
  // Canonical changes and lexical indexing progress change what is pending;
  // refresh the durable counts (debounced) and wake the loop.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if (!disposed) void readStatus(); }, 300); };
  const unsubscribeChanges = services.storage.onChange(() => { indexer?.wake(); scheduleRefresh(); });
  const searchEvents = services.storage as StorageClient & { onSearchChange?(listener: () => void): () => void };
  const unsubscribeSearch = typeof searchEvents.onSearchChange === "function" ? searchEvents.onSearchChange(() => { indexer?.wake(); scheduleRefresh(); }) : null;
  const queryAvailability = (next: Partial<SemanticSnapshot>): SemanticSnapshot["query"] => {
    const status = next.status ?? state.status, runtime = next.runtime ?? state.runtime;
    if (!services.embedding) return { available: false, reason: "This host does not provide the local embedding model." };
    if (!status || status.state === "disabled") return { available: false, reason: "Semantic search is not enabled." };
    if (runtime === "failed") return { available: false, reason: next.error ?? state.error ?? "The local embedding runtime failed." };
    return { available: true, reason: null };
  };
  const patch = (change: Partial<SemanticSnapshot>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...change, query: queryAvailability(change) });
    for (const listener of listeners) { try { listener(); } catch { /* isolate */ } }
  };
  async function readStatus(): Promise<SemanticIndexStatus | null> {
    try {
      const status = await services.storage.request(id(), "semanticStatus", null);
      patch({ status });
      return status;
    } catch (error) {
      patch({ error: describe(error) });
      return null;
    }
  }
  /** Load the runtime once; a failure is recorded and retried by explicit action. */
  async function ensureRuntime(): Promise<EmbeddingService> {
    if (service) return service;
    if (loading) return loading;
    if (!services.embedding) throw new EmbeddingServiceError("assets", "This host does not provide the local embedding model.");
    patch({ runtime: "loading", error: null });
    loading = (async () => {
      const index = await services.storage.request(id(), "searchStatus", null);
      const host = services.embedding!;
      worker ??= createEmbeddingWorker();
      const created = await createEmbeddingService({ worker, assets: embeddingAssets(host, index.version), ...(host.preferGpu === undefined ? {} : { preferGpu: host.preferGpu }), ...(host.cacheDirectory === undefined ? {} : { cacheDirectory: host.cacheDirectory }) });
      if (disposed) { await created.shutdown(); throw new EmbeddingServiceError("closed", "Disposed during initialization"); }
      service = created;
      unsubscribeStatistics = created.onStatistics((statistics) => patch({ chunksPerSecond: statistics.recentChunksPerSecond, estimatedRemainingSeconds: state.indexer?.estimatedRemainingSeconds ?? statistics.estimatedRemainingSeconds }));
      patch({ runtime: "ready", report: created.report });
      return created;
    })();
    try { return await loading; }
    catch (error) { patch({ runtime: "failed", error: describe(error) }); throw error; }
    finally { loading = null; }
  }
  async function startIndexing(): Promise<void> {
    const runtime = await ensureRuntime();
    if (indexer) { await indexer.resume(); return; }
    indexer = createSemanticIndexer({ storage: services.storage, embeddings: runtime, idleDelayMs: 5_000, onChange: (snapshot) => patch({ indexer: snapshot, status: snapshot.status ?? state.status, estimatedRemainingSeconds: snapshot.estimatedRemainingSeconds, chunksPerSecond: snapshot.runtime?.recentChunksPerSecond ?? state.chunksPerSecond }) });
    indexer.start();
  }
  async function stopIndexing(): Promise<void> {
    const current = indexer; indexer = null;
    await current?.stop();
  }
  async function unloadRuntime(): Promise<void> {
    await stopIndexing();
    unsubscribeStatistics?.(); unsubscribeStatistics = null;
    const current = service; service = null;
    await current?.shutdown();
    patch({ runtime: services.embedding ? "not-loaded" : "no-host-assets", report: null, chunksPerSecond: null });
  }
  async function run(work: () => Promise<void>): Promise<void> {
    if (state.busy) return;
    patch({ busy: true, error: null });
    try { await work(); }
    catch (error) { patch({ error: describe(error) }); }
    finally { patch({ busy: false }); await readStatus(); }
  }
  const controller = {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Read storage; resume background indexing for an enrolled archive. */
    async initialize() {
      const status = await readStatus();
      if (status?.state === "enrolled" && services.embedding) await run(startIndexing);
    },
    refresh: () => readStatus(),
    /** Onboarding step 5 / settings: enrol the pinned model and start indexing. */
    enable: () => run(async () => {
      const index = await services.storage.request(id(), "searchStatus", null);
      await services.storage.request(id(), "enrollSemantic", { operationId: id(), model: embeddingModelIdentity(index.version) });
      await startIndexing();
    }),
    pause: () => run(async () => {
      await services.storage.request(id(), "setSemanticState", { state: "paused" });
      await indexer?.pause();
    }),
    resume: () => run(async () => {
      await services.storage.request(id(), "setSemanticState", { state: "enrolled" });
      await startIndexing();
    }),
    /** Keep the index, stop indexing and release the runtime's memory. */
    disable: () => run(async () => {
      await services.storage.request(id(), "setSemanticState", { state: "paused" });
      await unloadRuntime();
    }),
    deleteIndex: () => run(async () => {
      await unloadRuntime();
      await services.storage.request(id(), "deleteSemanticIndex", { operationId: id() });
    }),
    rebuild: () => run(async () => {
      await stopIndexing();
      await services.storage.request(id(), "deleteSemanticIndex", { operationId: id() });
      const index = await services.storage.request(id(), "searchStatus", null);
      await services.storage.request(id(), "enrollSemantic", { operationId: id(), model: embeddingModelIdentity(index.version) });
      await startIndexing();
    }),
    /** Query semantics, interactive priority; null with a reason when unavailable. */
    async embedQuery(text: string, signal?: AbortSignal): Promise<{ vector: number[] } | { vector: null; reason: string }> {
      const availability = queryAvailability({});
      if (!availability.available) return { vector: null, reason: availability.reason ?? "Semantic search is unavailable." };
      try {
        const runtime = await ensureRuntime();
        const result = await runtime.embed(text, "query", { priority: 0, ...(signal ? { signal } : {}) });
        return { vector: Array.from(result.vector) };
      } catch (error) {
        return { vector: null, reason: describe(error) };
      }
    },
    async dispose() {
      disposed = true;
      clearTimeout(refreshTimer);
      unsubscribeChanges();
      unsubscribeSearch?.();
      await stopIndexing();
      unsubscribeStatistics?.();
      const current = service; service = null;
      await current?.shutdown();
      // Page teardown ends the parked worker with the document; an explicit
      // terminate here would hit the WebKit teardown crash while the page lives.
      worker = null;
    },
  };
  return controller;
}
export type SemanticController = ReturnType<typeof createSemanticController>;
