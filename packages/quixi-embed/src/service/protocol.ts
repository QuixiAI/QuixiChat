import type { EmbeddingRole } from '../scalar.ts';
import type { EmbeddingIdentity, EmbeddingPriority, SchedulerFailureCode, SchedulerStatistics } from '../scheduler/types.ts';

/** Every asset is named by URL and pinned SHA-256; the worker refuses any
 * byte stream whose digest differs. The caller owns URL resolution. */
export interface EmbeddingAssets {
  model: { url: string; sha256: string; bytes: number };
  tokenizer: { url: string; sha256: string; bytes: number };
  scalarWasm: { url: string; sha256: string };
  simdWasm: { url: string; sha256: string };
  /** WGSL sources; when absent the GPU route is never attempted. */
  shaders?: { baseline: string; tiled: string; half: string; attention: string };
  identity: EmbeddingIdentity;
}
export interface EmbeddingServiceOptions {
  assets: EmbeddingAssets;
  /** Attempt WebGPU first when the browser exposes it; SIMD/scalar remain the fallback. */
  preferGpu?: boolean;
  /** OPFS directory for the verified model copy; null disables caching. */
  cacheDirectory?: string | null;
  /** Bound on one embed round trip, including queueing behind background work. */
  requestTimeoutMs?: number;
  initializationTimeoutMs?: number;
}
export interface EmbeddingBackendReport {
  route: string;
  kind: 'cpu' | 'gpu';
  simdSupported: boolean;
  gpuAttempted: boolean;
  initialGpuError: string | null;
  modelSource: 'cache' | 'network';
  cacheWritten: boolean;
  initializationMs: number;
  identity: EmbeddingIdentity;
}
export type EmbeddingServiceFailureCode = SchedulerFailureCode | 'assets' | 'unavailable' | 'timeout' | 'protocol';
export class EmbeddingServiceError extends Error {
  readonly code: EmbeddingServiceFailureCode;
  constructor(code: EmbeddingServiceFailureCode, message: string) { super(message); this.name = 'EmbeddingServiceError'; this.code = code; }
}
export type ServiceRequest =
  | { kind: 'init'; id: number; assets: EmbeddingAssets; preferGpu: boolean; cacheDirectory: string | null }
  | { kind: 'embed'; id: number; text: string; role: EmbeddingRole; priority: EmbeddingPriority }
  | { kind: 'cancel'; id: number; target: number }
  | { kind: 'pause'; id: number }
  | { kind: 'resume'; id: number }
  | { kind: 'clearCache'; id: number }
  | { kind: 'statistics'; id: number; remainingDocuments: number | null }
  | { kind: 'shutdown'; id: number; mode: 'cancel' | 'drain' };
export type ServiceReply =
  | { kind: 'ready'; id: number; report: EmbeddingBackendReport }
  | { kind: 'vector'; id: number; vector: Float32Array; route: string; cacheHit: boolean }
  | { kind: 'done'; id: number }
  | { kind: 'statistics'; id: number | null; statistics: SchedulerStatistics }
  | { kind: 'failure'; id: number; code: EmbeddingServiceFailureCode; message: string };
export const SERVICE_PROTOCOL_VERSION = 1;
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
