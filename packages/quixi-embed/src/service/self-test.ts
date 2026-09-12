/** Product §100 inference diagnostics (plan 23): model hash, tokenizer,
 * scalar golden, WASM SIMD backend and WebGPU backend, each classified with
 * the ADR 0040 outcome vocabulary. The comparison logic is pure so it can be
 * tested in Node with substituted encoders; the worker supplies real ones. */
import { SELF_TEST_CASES, SELF_TEST_GOLDEN_MANIFEST_SHA256 } from './self-test-cases.ts';
import type { SelfTestCase } from './self-test-cases.ts';
import type { EmbeddingRole } from '../scalar.ts';

export type InferenceCheckId = 'model_hash' | 'tokenizer' | 'scalar_golden' | 'wasm_simd_backend' | 'webgpu_backend';
export type InferenceOutcome = 'ok' | 'corruption' | 'unsupported' | 'attention' | 'unknown';
export interface InferenceCheck {
  id: InferenceCheckId;
  outcome: InferenceOutcome;
  summary: string;
  measured: Record<string, string | number | boolean | null>;
}
export interface InferenceSelfTest {
  version: 1;
  producedAt: number;
  /** The route serving queries when the test ran. */
  route: string;
  kind: 'cpu' | 'gpu';
  goldenManifestSha256: string;
  cases: string[];
  thresholds: typeof SELF_TEST_THRESHOLDS;
  elapsedMs: number;
  checks: InferenceCheck[];
}
/** CPU routes must reproduce the goldens to the parity suites' tolerance
 * (wasm-parity-report.json: min cosine 0.999999, vector atol 2e-5). The GPU
 * routes accumulate in FP32 or FP16 with different reduction orders, so they
 * carry their own bounds; a vector below them would change rankings. */
export const SELF_TEST_THRESHOLDS = Object.freeze({
  cpu: { minCosine: 0.999999, maxAbsolute: 2e-5 },
  gpuFp32: { minCosine: 0.9999, maxAbsolute: 1e-3 },
  gpuFp16: { minCosine: 0.999, maxAbsolute: 5e-3 },
});
export interface VectorComparison { cosine: number; maxAbsolute: number; norm: number }
export function compareVector(actual: ArrayLike<number>, golden: ArrayLike<number>): VectorComparison {
  if (actual.length !== golden.length) return { cosine: 0, maxAbsolute: Number.POSITIVE_INFINITY, norm: 0 };
  let dot = 0, na = 0, ng = 0, maxAbsolute = 0;
  for (let index = 0; index < actual.length; index++) {
    const a = actual[index]!, g = golden[index]!;
    if (!Number.isFinite(a)) return { cosine: 0, maxAbsolute: Number.POSITIVE_INFINITY, norm: 0 };
    dot += a * g; na += a * a; ng += g * g;
    maxAbsolute = Math.max(maxAbsolute, Math.abs(a - g));
  }
  return { cosine: na && ng ? dot / Math.sqrt(na * ng) : 0, maxAbsolute, norm: Math.sqrt(na) };
}
export interface SelfTestEnvironment {
  expectedModelSha256: string;
  /** Reloads and re-hashes the model artifact from its cache or source. */
  loadModel(): Promise<{ sha256: string; source: 'cache' | 'network'; model: Uint8Array }>;
  tokenize(text: string, role: EmbeddingRole): ArrayLike<number>;
  createScalar(model: Uint8Array): Promise<{ embed(text: string, role: EmbeddingRole): Float32Array; dispose(): void }>;
  simdSupported: boolean;
  createSimd: ((model: Uint8Array) => Promise<{ embed(text: string, role: EmbeddingRole): Float32Array; dispose(): void }>) | null;
  /** The scheduler's live route. */
  route: string;
  kind: 'cpu' | 'gpu';
  gpu: {
    attempted: boolean;
    initialError: string | null;
    /** Embeds through the live scheduler when its route is a GPU one; the reply names the route that actually served. */
    embed: ((text: string, role: EmbeddingRole) => Promise<{ vector: Float32Array; route: string }>) | null;
    /** Probes the adapter without creating a device. */
    probe(): Promise<{ available: boolean; f16: boolean; fallbackAdapter: boolean | null; reason: string | null }>;
  };
}
const check = (id: InferenceCheckId, outcome: InferenceOutcome, summary: string, measured: InferenceCheck['measured'] = {}): InferenceCheck => ({ id, outcome, summary, measured });
const reason = (error: unknown) => { const text = error instanceof Error ? error.message : String(error); return text.length > 200 ? `${text.slice(0, 199)}…` : text; };
function worst(cases: readonly SelfTestCase[], embed: (item: SelfTestCase) => ArrayLike<number>): { minCosine: number; maxAbsolute: number; failed: string | null } {
  let minCosine = 1, maxAbsolute = 0, failed: string | null = null;
  for (const item of cases) {
    const comparison = compareVector(embed(item), item.vector);
    if (comparison.cosine < minCosine) { minCosine = comparison.cosine; }
    if (comparison.maxAbsolute > maxAbsolute) maxAbsolute = comparison.maxAbsolute;
    if (Math.abs(comparison.norm - 1) > 1e-3 && !failed) failed = item.id;
  }
  return { minCosine, maxAbsolute, failed };
}
function classify(id: InferenceCheckId, label: string, result: { minCosine: number; maxAbsolute: number; failed: string | null }, bounds: { minCosine: number; maxAbsolute: number }, extra: InferenceCheck['measured'] = {}): InferenceCheck {
  const measured = { ...extra, cases: SELF_TEST_CASES.length, minCosine: Number(result.minCosine.toFixed(8)), maxAbsolute: Number(result.maxAbsolute.toPrecision(3)), minCosineBound: bounds.minCosine, maxAbsoluteBound: bounds.maxAbsolute };
  if (result.failed) return check(id, 'corruption', `${label} produced a vector that is not unit length; do not trust semantic results from this build.`, { ...measured, unnormalized: result.failed });
  if (result.minCosine < bounds.minCosine || result.maxAbsolute > bounds.maxAbsolute) return check(id, 'corruption', `${label} does not reproduce the reference vectors within tolerance; semantic rankings from it are unreliable.`, measured);
  return check(id, 'ok', `${label} reproduces the frozen reference vectors.`, measured);
}
export async function runInferenceSelfTest(environment: SelfTestEnvironment): Promise<InferenceSelfTest> {
  const started = Date.now();
  const checks: InferenceCheck[] = [];
  let model: Uint8Array | null = null;
  // 1. Model hash: the artifact is re-read and re-hashed, not trusted from initialization.
  try {
    const loaded = await environment.loadModel();
    if (loaded.sha256 === environment.expectedModelSha256) {
      model = loaded.model;
      checks.push(check('model_hash', 'ok', `The model artifact's SHA-256 matches the pinned lock (re-read from ${loaded.source}).`, { sha256: loaded.sha256, source: loaded.source, bytes: loaded.model.byteLength }));
    } else checks.push(check('model_hash', 'corruption', 'The model artifact does not match its pinned SHA-256.', { sha256: loaded.sha256, expected: environment.expectedModelSha256, source: loaded.source, bytes: loaded.model.byteLength }));
  } catch (error) {
    checks.push(check('model_hash', 'corruption', 'The model artifact could not be re-read and verified.', { reason: reason(error) }));
  }
  // 2. Tokenizer: exact ids for the frozen cases.
  try {
    let mismatched: string | null = null;
    for (const item of SELF_TEST_CASES) {
      const ids = Array.from(environment.tokenize(item.text, item.role));
      if (ids.length !== item.ids.length || ids.some((value, index) => value !== item.ids[index])) { mismatched = item.id; break; }
    }
    checks.push(mismatched
      ? check('tokenizer', 'corruption', 'The tokenizer does not reproduce the frozen token ids.', { cases: SELF_TEST_CASES.length, mismatched })
      : check('tokenizer', 'ok', 'The tokenizer reproduces the frozen token ids exactly.', { cases: SELF_TEST_CASES.length, mismatched: null }));
  } catch (error) {
    checks.push(check('tokenizer', 'corruption', 'The tokenizer failed on a frozen case.', { reason: reason(error) }));
  }
  // 3. Scalar golden: the reference WASM build against the frozen vectors.
  if (!model) checks.push(check('scalar_golden', 'unknown', 'Skipped because the model artifact could not be loaded.', {}));
  else {
    try {
      const scalar = await environment.createScalar(model);
      try { checks.push(classify('scalar_golden', 'The scalar WASM backend', worst(SELF_TEST_CASES, item => scalar.embed(item.text, item.role)), SELF_TEST_THRESHOLDS.cpu, { route: 'wasm-scalar-fp32' })); }
      finally { scalar.dispose(); }
    } catch (error) {
      checks.push(check('scalar_golden', 'corruption', 'The scalar WASM backend could not run the frozen cases.', { reason: reason(error) }));
    }
  }
  // 4. WASM SIMD backend: supported here, and reproducing the goldens.
  if (!environment.simdSupported || !environment.createSimd) checks.push(check('wasm_simd_backend', 'unsupported', 'This browser has no WebAssembly SIMD; the scalar backend serves instead. Nothing is damaged.', { supported: false }));
  else if (!model) checks.push(check('wasm_simd_backend', 'unknown', 'Skipped because the model artifact could not be loaded.', { supported: true }));
  else {
    try {
      const simd = await environment.createSimd(model);
      try { checks.push(classify('wasm_simd_backend', 'The WASM SIMD backend', worst(SELF_TEST_CASES, item => simd.embed(item.text, item.role)), SELF_TEST_THRESHOLDS.cpu, { supported: true, route: 'wasm-simd-fp32' })); }
      finally { simd.dispose(); }
    } catch (error) {
      checks.push(check('wasm_simd_backend', 'corruption', 'The WASM SIMD backend could not run the frozen cases.', { supported: true, reason: reason(error) }));
    }
  }
  // 5. WebGPU backend: the live route against the goldens, or why it is not in use.
  if (environment.kind === 'gpu' && environment.gpu.embed) {
    try {
      const vectors = new Map<string, Float32Array>();
      let served: string | null = null;
      for (const item of SELF_TEST_CASES) { const result = await environment.gpu.embed(item.text, item.role); vectors.set(item.id, result.vector); served = result.route; }
      if (!served || !served.startsWith('webgpu')) checks.push(check('webgpu_backend', 'attention', 'The GPU route was lost during the test; the CPU backend served the frozen cases instead.', { active: false, route: environment.route, servedBy: served }));
      else {
        const bounds = /fp16|f16|half/.test(served) ? SELF_TEST_THRESHOLDS.gpuFp16 : SELF_TEST_THRESHOLDS.gpuFp32;
        checks.push(classify('webgpu_backend', `The WebGPU backend (${served})`, worst(SELF_TEST_CASES, item => vectors.get(item.id)!), bounds, { active: true, route: served }));
      }
    } catch (error) {
      checks.push(check('webgpu_backend', 'attention', 'The WebGPU backend failed while running the frozen cases; the scheduler falls back to the CPU backend.', { active: true, route: environment.route, reason: reason(error) }));
    }
  } else {
    let probe: Awaited<ReturnType<SelfTestEnvironment['gpu']['probe']>>;
    try { probe = await environment.gpu.probe(); } catch (error) { probe = { available: false, f16: false, fallbackAdapter: null, reason: reason(error) }; }
    const measured = { active: false, route: environment.route, attempted: environment.gpu.attempted, adapter: probe.available, f16: probe.f16, fallbackAdapter: probe.fallbackAdapter, reason: environment.gpu.initialError ?? probe.reason };
    if (!probe.available) checks.push(check('webgpu_backend', 'unsupported', 'WebGPU is not available in this browser; the CPU backend serves. Nothing is damaged.', measured));
    else if (!environment.gpu.attempted) checks.push(check('webgpu_backend', 'attention', 'A WebGPU adapter exists but the GPU route was not attempted (disabled by the host).', measured));
    else checks.push(check('webgpu_backend', 'attention', 'A WebGPU adapter exists but the GPU route was refused or failed at start; the CPU backend serves.', measured));
  }
  return { version: 1, producedAt: Date.now(), route: environment.route, kind: environment.kind, goldenManifestSha256: SELF_TEST_GOLDEN_MANIFEST_SHA256, cases: SELF_TEST_CASES.map(item => item.id), thresholds: SELF_TEST_THRESHOLDS, elapsedMs: Date.now() - started, checks };
}
