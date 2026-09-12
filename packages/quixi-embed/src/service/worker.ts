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
import { fetchVerified, loadModelBytes, sha256Hex } from './assets.ts';
import { runInferenceSelfTest } from './self-test.ts';
import type { EmbeddingAssets } from './protocol.ts';
import { EmbeddingServiceError, SERVICE_PROTOCOL_VERSION } from './protocol.ts';
import type { EmbeddingBackendReport, ServiceReply, ServiceRequest } from './protocol.ts';

let scheduler: EmbeddingScheduler | undefined;
let tokenizer: ArcticTokenizer | undefined;
/** What the self-test needs beyond the live scheduler: the verified small
 * assets and how the model was obtained. The model bytes themselves are not
 * retained; the self-test re-reads and re-hashes them. */
let retained: { assets: EmbeddingAssets; cacheDirectory: string | null; scalarWasm: Uint8Array; simdWasm: Uint8Array | null; simdSupported: boolean; gpuAttempted: boolean; initialGpuError: string | null } | undefined;
let selfTesting = false;
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
    retained = { assets, cacheDirectory: request.cacheDirectory, scalarWasm, simdWasm, simdSupported, gpuAttempted, initialGpuError: report.initialGpuError };
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
    case 'selfTest': {
      const current = live();
      if (!retained || !tokenizer) throw new EmbeddingServiceError('unavailable', 'The embedding worker has no verified assets to test.');
      if (selfTesting) throw new EmbeddingServiceError('saturated', 'A self-test is already running.');
      selfTesting = true;
      try {
        const { assets, cacheDirectory, scalarWasm, simdWasm, simdSupported, gpuAttempted, initialGpuError } = retained;
        const inspector = tokenizer;
        const statistics = current.statistics();
        const result = await runInferenceSelfTest({
          expectedModelSha256: assets.model.sha256,
          async loadModel() {
            const model = await loadModelBytes({ url: assets.model.url, sha256: assets.model.sha256, bytes: assets.model.bytes, cacheDirectory });
            return { sha256: await sha256Hex(model.bytes), source: model.source, model: model.bytes };
          },
          tokenize: (text, role) => inspector.tokenize(text, role),
          createScalar: async model => { const encoder = await createScalarEncoder({ wasm: scalarWasm, model }); return { embed: (text, role) => role === 'query' ? encoder.embedQuery(text) : encoder.embedDocument(text), dispose: () => encoder.dispose() }; },
          simdSupported,
          createSimd: simdWasm ? async model => { const encoder = await createSimdEncoder({ wasm: simdWasm, model }); return { embed: (text, role) => role === 'query' ? encoder.embedQuery(text) : encoder.embedDocument(text), dispose: () => encoder.dispose() }; } : null,
          route: statistics.route, kind: statistics.kind,
          gpu: {
            attempted: gpuAttempted, initialError: initialGpuError,
            // The scheduler memoizes by input, so the cases must not be served from memory.
            embed: statistics.kind === 'gpu' ? async (text, role) => { current.clearCache(); const ticket = current.submit({ text, role, priority: 0 }); const done = await ticket.result; return { vector: done.vector, route: done.route }; } : null,
            async probe() {
              const gpu = (navigator as Navigator & { gpu?: { requestAdapter(options?: unknown): Promise<{ features: Set<string>; isFallbackAdapter?: boolean } | null> } }).gpu;
              if (!gpu) return { available: false, f16: false, fallbackAdapter: null, reason: 'navigator.gpu is absent' };
              const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }) as { features: Set<string>; isFallbackAdapter?: boolean } | null;
              if (!adapter) return { available: false, f16: false, fallbackAdapter: null, reason: 'no WebGPU adapter' };
              return { available: true, f16: adapter.features.has('shader-f16'), fallbackAdapter: adapter.isFallbackAdapter ?? null, reason: null };
            },
          },
        });
        post({ kind: 'selfTest', id: request.id, result });
      } finally { selfTesting = false; }
      return;
    }
    case 'statistics': post({ kind: 'statistics', id: request.id, statistics: live().statistics(request.remainingDocuments ?? undefined) }); return;
    case 'shutdown': {
      closed = true;
      clearTimeout(statisticsTimer);
      const current = scheduler; scheduler = undefined; retained = undefined;
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
