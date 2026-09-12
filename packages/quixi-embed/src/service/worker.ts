/** Dedicated embedding worker: verified assets, backend selection, the bounded
 * scheduler and an RPC boundary. It opens no database and publishes nothing
 * durable; the owner rejects late results through its own generation checks. */
import { createScalarEncoder } from '../scalar.ts';
import type { EmbeddingRole, TokenInspection } from '../scalar.ts';
import { createSimdEncoder, supportsWasmSimd } from '../simd.ts';
import { createArcticTokenizer, type ArcticTokenizer } from '../tokenizer.ts';
import { createWebGpuEncoder, GpuBackendError } from '../gpu/encoder.ts';
import { SchedulerError } from '../scheduler/scheduler.ts';
import { cpuSchedulerExecutor, gpuSchedulerExecutor, createSchedulerWithFallback } from '../scheduler/executors.ts';
import type { EmbeddingScheduler, EmbeddingTicket, SchedulerStatistics } from '../scheduler/types.ts';
import { fetchVerified, loadModelBytes } from './assets.ts';
import { EmbeddingServiceError, SERVICE_PROTOCOL_VERSION } from './protocol.ts';
import type { EmbeddingBackendReport, ServiceReply, ServiceRequest } from './protocol.ts';

let scheduler: EmbeddingScheduler | undefined;
let tokenizer: ArcticTokenizer | undefined;
let initializing = false, closed = false;
const tickets = new Map<number, EmbeddingTicket>();
let statisticsTimer: ReturnType<typeof setTimeout> | undefined, lastStatistics = 0;
const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void };
const post = (reply: ServiceReply, transfer: Transferable[] = []) => scope.postMessage({ version: SERVICE_PROTOCOL_VERSION, ...reply }, transfer);
const fail = (id: number, error: unknown) => {
  const code = error instanceof EmbeddingServiceError ? error.code : error instanceof SchedulerError ? error.code : error instanceof GpuBackendError ? 'unavailable' : 'backend';
  post({ kind: 'failure', id, code, message: error instanceof Error ? error.message : String(error) });
};
/** Statistics events are coalesced to at most four per second. */
function publishStatistics(statistics: SchedulerStatistics): void {
  const elapsed = performance.now() - lastStatistics;
  if (elapsed >= 250) { lastStatistics = performance.now(); post({ kind: 'statistics', id: null, statistics }); return; }
  if (statisticsTimer) return;
  statisticsTimer = setTimeout(() => { statisticsTimer = undefined; if (scheduler && !closed) { lastStatistics = performance.now(); post({ kind: 'statistics', id: null, statistics: scheduler.statistics() }); } }, 250 - elapsed);
}
async function initialize(request: Extract<ServiceRequest, { kind: 'init' }>): Promise<void> {
  if (scheduler || initializing) throw new EmbeddingServiceError('protocol', 'The embedding worker is already initialized.');
  // A parked worker (after shutdown) initializes again in place: WebKit
  // crashes when a worker scope that ever held a WebGPU device is destroyed,
  // so owners keep one worker for the page's lifetime instead of recreating it.
  initializing = true; closed = false; tickets.clear();
  const started = performance.now();
  const assets = request.assets;
  const simdSupported = supportsWasmSimd();
  let preflightTokenizer: ArcticTokenizer | undefined;
  try {
    const [scalarWasm, simdWasm, tokenizerBytes, model] = await Promise.all([
      fetchVerified(assets.scalarWasm.url, assets.scalarWasm.sha256, 4 * 1024 * 1024),
      simdSupported ? fetchVerified(assets.simdWasm.url, assets.simdWasm.sha256, 4 * 1024 * 1024) : Promise.resolve(null),
      fetchVerified(assets.tokenizer.url, assets.tokenizer.sha256, assets.tokenizer.bytes),
      loadModelBytes({ url: assets.model.url, sha256: assets.model.sha256, bytes: assets.model.bytes, cacheDirectory: request.cacheDirectory }),
    ]);
    const inspector = await createArcticTokenizer({ wasm: scalarWasm, tokenizer: tokenizerBytes });
    preflightTokenizer = inspector;
    // The closure must outlive initialization: it serves every later dispatch
    // and survives GPU loss, so it binds the instance, not the local slot.
    const preflight = (text: string, role: EmbeddingRole): TokenInspection => inspector.inspect(text, role);
    const createCpu = async () => cpuSchedulerExecutor(simdWasm ? await createSimdEncoder({ wasm: simdWasm, model: model.bytes }) : await createScalarEncoder({ wasm: scalarWasm, model: model.bytes }));
    const gpuAttempted = request.preferGpu && !!assets.shaders && typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
    const createGpu = async () => {
      const shaders = assets.shaders!;
      const encoder = await createWebGpuEncoder({ model: model.bytes, tokenizer: tokenizerBytes, wasm: scalarWasm, shader: shaders.baseline, tiledShader: shaders.tiled, halfShader: shaders.half, attentionShader: shaders.attention, projection: 'auto', attention: 'fused', maxBatch: 4 });
      const diagnostics = encoder.diagnostics();
      if (diagnostics.adapter.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(JSON.stringify(diagnostics.adapter))) { encoder.dispose(); throw new GpuBackendError('unavailable', 'Software WebGPU adapters are slower than SIMD; using the CPU route.'); }
      return gpuSchedulerExecutor({ encoder, preflight });
    };
    const initialized = await createSchedulerWithFallback({ identity: assets.identity, preflight, createCpu, ...(gpuAttempted ? { createGpu } : {}), onEvent: event => publishStatistics(event.statistics) });
    if (closed) { await initialized.scheduler.shutdown(); throw new EmbeddingServiceError('closed', 'The embedding worker closed during initialization.'); }
    scheduler = initialized.scheduler;
    tokenizer = preflightTokenizer; preflightTokenizer = undefined;
    const statistics = scheduler.statistics();
    const report: EmbeddingBackendReport = {
      route: statistics.route, kind: statistics.kind, simdSupported, gpuAttempted,
      initialGpuError: initialized.initialGpuError ? String((initialized.initialGpuError as Error).message ?? initialized.initialGpuError) : null,
      modelSource: model.source, cacheWritten: model.cacheWritten, initializationMs: performance.now() - started, identity: scheduler.identity,
    };
    post({ kind: 'ready', id: request.id, report });
  } finally {
    preflightTokenizer?.dispose();
    initializing = false;
  }
}
function live(): EmbeddingScheduler {
  if (!scheduler) throw new EmbeddingServiceError('unavailable', 'The embedding worker is not initialized.');
  return scheduler;
}
async function handle(request: ServiceRequest): Promise<void> {
  switch (request.kind) {
    case 'init': await initialize(request); return;
    case 'embed': {
      if (typeof request.text !== 'string' || !['query', 'document'].includes(request.role)) throw new EmbeddingServiceError('invalid', 'Invalid embedding request');
      const ticket = live().submit({ text: request.text, role: request.role, priority: request.priority });
      tickets.set(request.id, ticket);
      ticket.result.then(result => { tickets.delete(request.id); post({ kind: 'vector', id: request.id, vector: result.vector, route: result.route, cacheHit: result.cacheHit }, [result.vector.buffer]); },
        error => { tickets.delete(request.id); fail(request.id, error); });
      return;
    }
    case 'cancel': tickets.get(request.target)?.cancel(); post({ kind: 'done', id: request.id }); return;
    case 'pause': live().pauseBackground(); post({ kind: 'done', id: request.id }); return;
    case 'resume': live().resumeBackground(); post({ kind: 'done', id: request.id }); return;
    case 'clearCache': live().clearCache(); post({ kind: 'done', id: request.id }); return;
    case 'fault': post({ kind: 'faulted', id: request.id, injected: request.fault === 'gpu-device-loss' ? live().injectFault('device-loss') : false }); return;
    case 'statistics': post({ kind: 'statistics', id: request.id, statistics: live().statistics(request.remainingDocuments ?? undefined) }); return;
    case 'shutdown': {
      closed = true;
      clearTimeout(statisticsTimer);
      const current = scheduler; scheduler = undefined;
      try { await current?.shutdown(request.mode); } finally { tokenizer?.dispose(); tokenizer = undefined; }
      // The worker stays parked with its model memory released; see initialize.
      post({ kind: 'done', id: request.id });
      return;
    }
    default: throw new EmbeddingServiceError('protocol', 'Unknown embedding worker request');
  }
}
self.onmessage = ({ data }: MessageEvent<ServiceRequest & { version?: number }>) => {
  if (!data || data.version !== SERVICE_PROTOCOL_VERSION || typeof data.id !== 'number') return;
  handle(data).catch(error => fail(data.id, error));
};
