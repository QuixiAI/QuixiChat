import type { EmbeddingRole } from '../scalar.ts';
import type { EmbeddingPriority, SchedulerStatistics } from '../scheduler/types.ts';
import { EmbeddingServiceError, SERVICE_PROTOCOL_VERSION } from './protocol.ts';
import type { DistributiveOmit, EmbeddingBackendReport, EmbeddingServiceOptions, ServiceReply, ServiceRequest } from './protocol.ts';

export interface EmbeddingService {
  readonly report: Readonly<EmbeddingBackendReport>;
  /** One vector per call; the copy belongs to the caller. */
  embed(text: string, role: EmbeddingRole, options?: { priority?: EmbeddingPriority; signal?: AbortSignal }): Promise<{ vector: Float32Array; route: string; cacheHit: boolean }>;
  statistics(remainingDocuments?: number): Promise<SchedulerStatistics>;
  /** Latest statistics pushed by the worker, when any have arrived. */
  latestStatistics(): SchedulerStatistics | null;
  onStatistics(listener: (statistics: SchedulerStatistics) => void): () => void;
  pauseBackground(): Promise<void>;
  resumeBackground(): Promise<void>;
  clearCache(): Promise<void>;
  /** Diagnostics: injects a backend fault; true when the live backend could take it (a GPU device loss), false otherwise. */
  injectFault(fault: 'gpu-device-loss'): Promise<boolean>;
  shutdown(mode?: 'cancel' | 'drain'): Promise<void>;
}
type Pending = { resolve: (reply: ServiceReply) => void; reject: (error: EmbeddingServiceError) => void; timer: ReturnType<typeof setTimeout> | undefined };
const MAX_PENDING = 1_100;

/** The dedicated worker module. Owners that enable and disable the runtime
 * repeatedly keep one worker per page and pass it to every service: a
 * shutdown parks it with its model memory released, and WebKit crashes when
 * a worker scope that ever held a WebGPU device is destroyed. */
export function createEmbeddingWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'quixi-embed' });
}
/** Initialize a worker with pinned assets. Nothing is fetched or loaded before
 * this call. A supplied worker is parked, not terminated, by `shutdown`;
 * an owned worker is terminated. */
export async function createEmbeddingService(options: EmbeddingServiceOptions & { worker?: Worker }): Promise<EmbeddingService> {
  const owned = !options.worker;
  const worker = options.worker ?? createEmbeddingWorker();
  const pending = new Map<number, Pending>();
  const listeners = new Set<(statistics: SchedulerStatistics) => void>();
  let nextId = 1, closed = false, latest: SchedulerStatistics | null = null;
  const requestTimeout = options.requestTimeoutMs ?? 120_000;
  const failAll = (error: EmbeddingServiceError) => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  worker.onmessage = ({ data }: MessageEvent<ServiceReply & { version?: number }>) => {
    if (!data || data.version !== SERVICE_PROTOCOL_VERSION) return;
    if (data.kind === 'statistics' && data.id === null) { latest = data.statistics; for (const listener of listeners) { try { listener(data.statistics); } catch { /* isolate */ } } return; }
    const id = data.id as number;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (data.kind === 'failure') entry.reject(new EmbeddingServiceError(data.code, data.message));
    else entry.resolve(data);
  };
  worker.onerror = event => { event.preventDefault(); failAll(new EmbeddingServiceError('backend', event.message || 'The embedding worker failed.')); };
  const call = (request: DistributiveOmit<ServiceRequest, 'id'>, timeoutMs: number, id = nextId++): Promise<ServiceReply> => {
    if (closed) return Promise.reject(new EmbeddingServiceError('closed', 'The embedding service is shut down.'));
    if (pending.size >= MAX_PENDING) return Promise.reject(new EmbeddingServiceError('saturated', 'Too many embedding requests are waiting.'));
    return new Promise<ServiceReply>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { pending.delete(id); reject(new EmbeddingServiceError('timeout', `Embedding request ${request.kind} timed out.`)); if (request.kind === 'embed') worker.postMessage({ version: SERVICE_PROTOCOL_VERSION, kind: 'cancel', id: nextId++, target: id }); }, timeoutMs) : undefined;
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ version: SERVICE_PROTOCOL_VERSION, id, ...request });
    });
  };
  let report: EmbeddingBackendReport;
  try {
    const ready = await call({ kind: 'init', assets: options.assets, preferGpu: options.preferGpu ?? true, cacheDirectory: options.cacheDirectory === undefined ? 'quixi-embed' : options.cacheDirectory }, options.initializationTimeoutMs ?? 600_000);
    if (ready.kind !== 'ready') throw new EmbeddingServiceError('protocol', 'Unexpected initialization reply');
    report = ready.report;
  } catch (error) {
    closed = true; worker.onmessage = null; worker.onerror = null;
    if (owned) worker.terminate();
    failAll(new EmbeddingServiceError('closed', 'Initialization failed'));
    throw error;
  }
  return {
    report,
    async embed(text, role, embedOptions = {}) {
      if (embedOptions.signal?.aborted) throw new EmbeddingServiceError('cancelled', 'Embedding request cancelled before submission');
      const id = nextId++;
      const abort = () => worker.postMessage({ version: SERVICE_PROTOCOL_VERSION, kind: 'cancel', id: nextId++, target: id });
      embedOptions.signal?.addEventListener('abort', abort, { once: true });
      try {
        const reply = await call({ kind: 'embed', text, role, priority: embedOptions.priority ?? 0 }, requestTimeout, id);
        if (reply.kind !== 'vector') throw new EmbeddingServiceError('protocol', 'Unexpected embedding reply');
        return { vector: reply.vector, route: reply.route, cacheHit: reply.cacheHit };
      } finally { embedOptions.signal?.removeEventListener('abort', abort); }
    },
    async statistics(remainingDocuments) {
      const reply = await call({ kind: 'statistics', remainingDocuments: remainingDocuments ?? null }, 10_000);
      if (reply.kind !== 'statistics') throw new EmbeddingServiceError('protocol', 'Unexpected statistics reply');
      latest = reply.statistics;
      return reply.statistics;
    },
    latestStatistics: () => latest,
    onStatistics(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async pauseBackground() { await call({ kind: 'pause' }, 10_000); },
    async resumeBackground() { await call({ kind: 'resume' }, 10_000); },
    async clearCache() { await call({ kind: 'clearCache' }, 10_000); },
    async injectFault(fault) { const reply = await call({ kind: 'fault', fault }, 10_000); return reply.kind === 'faulted' ? reply.injected : false; },
    async shutdown(mode = 'cancel') {
      if (closed) return;
      let graceful = false;
      try { await call({ kind: 'shutdown', mode }, 30_000); graceful = true; } catch { /* terminate below */ }
      closed = true;
      worker.onmessage = null; worker.onerror = null;
      if (owned || !graceful) worker.terminate();
      failAll(new EmbeddingServiceError('closed', 'The embedding service is shut down.'));
      listeners.clear();
    },
  };
}
