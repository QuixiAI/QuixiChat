/** Plan 23 inference self-test classification with substituted encoders. The
 * real encoders are exercised by the application proof; this test pins how
 * each observation maps to an outcome. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInferenceSelfTest, compareVector, SELF_TEST_THRESHOLDS } from '../src/service/self-test.ts';
import { SELF_TEST_CASES, SELF_TEST_GOLDEN_MANIFEST_SHA256 } from '../src/service/self-test-cases.ts';

const PIN = 'e1ef345cd35088b06f70c199f5a4e0311bda5983716ad6a3e7d0a604202efffc';
const golden = (text, role) => Float32Array.from(SELF_TEST_CASES.find(item => item.text === text && item.role === role).vector);
const perturb = (vector, delta) => { const copy = Float32Array.from(vector); copy[0] += delta; copy[1] -= delta; return copy; };
const encoder = (embed = golden) => async () => ({ embed, dispose() {} });
function environment(overrides = {}) {
  return {
    expectedModelSha256: PIN,
    loadModel: async () => ({ sha256: PIN, source: 'cache', model: new Uint8Array(16) }),
    tokenize: (text, role) => SELF_TEST_CASES.find(item => item.text === text && item.role === role).ids,
    createScalar: encoder(), simdSupported: true, createSimd: encoder(),
    route: 'wasm-simd-fp32', kind: 'cpu',
    gpu: { attempted: true, initialError: 'Software WebGPU adapters are refused', embed: null, probe: async () => ({ available: true, f16: true, fallbackAdapter: true, reason: null }) },
    ...overrides,
  };
}
const outcome = (result, id) => result.checks.find(check => check.id === id);

test('the frozen cases are unit vectors with the pinned golden manifest', () => {
  assert.equal(SELF_TEST_CASES.length, 3);
  assert.match(SELF_TEST_GOLDEN_MANIFEST_SHA256, /^[0-9a-f]{64}$/);
  for (const item of SELF_TEST_CASES) { assert.equal(item.vector.length, 384); assert.ok(Math.abs(compareVector(item.vector, item.vector).norm - 1) < 1e-4, item.id); assert.ok(item.ids.length >= 2); }
});
test('a healthy CPU host: model, tokenizer, scalar and SIMD ok; WebGPU refused at start is attention with the reason', async () => {
  const result = await runInferenceSelfTest(environment());
  assert.deepEqual(result.checks.map(check => check.id), ['model_hash', 'tokenizer', 'scalar_golden', 'wasm_simd_backend', 'webgpu_backend']);
  assert.deepEqual(result.checks.map(check => check.outcome), ['ok', 'ok', 'ok', 'ok', 'attention']);
  assert.equal(outcome(result, 'model_hash').measured.source, 'cache');
  assert.equal(outcome(result, 'scalar_golden').measured.minCosine, 1);
  assert.equal(outcome(result, 'webgpu_backend').measured.reason, 'Software WebGPU adapters are refused');
  assert.equal(result.thresholds, SELF_TEST_THRESHOLDS);
  assert.ok(!JSON.stringify(result).includes(SELF_TEST_CASES[0].text), 'case text stays out of the result');
});
test('a model whose digest differs is corruption and skips the golden runs', async () => {
  const result = await runInferenceSelfTest(environment({ loadModel: async () => ({ sha256: 'a'.repeat(64), source: 'network', model: new Uint8Array(1) }) }));
  assert.equal(outcome(result, 'model_hash').outcome, 'corruption');
  assert.equal(outcome(result, 'scalar_golden').outcome, 'unknown');
  assert.equal(outcome(result, 'wasm_simd_backend').outcome, 'unknown');
  assert.equal(outcome(result, 'tokenizer').outcome, 'ok');
});
test('a tokenizer that drifts by one id is corruption', async () => {
  const result = await runInferenceSelfTest(environment({ tokenize: (text, role) => { const ids = [...SELF_TEST_CASES.find(item => item.text === text && item.role === role).ids]; ids[1] += 1; return ids; } }));
  assert.equal(outcome(result, 'tokenizer').outcome, 'corruption');
  assert.equal(outcome(result, 'tokenizer').measured.mismatched, SELF_TEST_CASES[0].id);
});
test('CPU vectors outside the parity tolerance are corruption; inside it they are ok', async () => {
  const drift = await runInferenceSelfTest(environment({ createScalar: encoder((text, role) => perturb(golden(text, role), 1e-3)) }));
  assert.equal(outcome(drift, 'scalar_golden').outcome, 'corruption');
  assert.ok(outcome(drift, 'scalar_golden').measured.maxAbsolute > SELF_TEST_THRESHOLDS.cpu.maxAbsolute);
  const fine = await runInferenceSelfTest(environment({ createSimd: encoder((text, role) => perturb(golden(text, role), 5e-6)) }));
  assert.equal(outcome(fine, 'wasm_simd_backend').outcome, 'ok');
  const unnormalized = await runInferenceSelfTest(environment({ createScalar: encoder((text, role) => golden(text, role).map(value => value * 2)) }));
  assert.equal(outcome(unnormalized, 'scalar_golden').outcome, 'corruption');
  assert.equal(outcome(unnormalized, 'scalar_golden').measured.unnormalized, SELF_TEST_CASES[0].id);
});
test('no WebAssembly SIMD is unsupported, not damage', async () => {
  const result = await runInferenceSelfTest(environment({ simdSupported: false, createSimd: null, route: 'wasm-scalar-fp32' }));
  assert.equal(outcome(result, 'wasm_simd_backend').outcome, 'unsupported');
});
test('WebGPU: absent is unsupported, present but not attempted is attention, active FP16 within its bound is ok, lost mid-test is attention', async () => {
  const absent = await runInferenceSelfTest(environment({ gpu: { attempted: false, initialError: null, embed: null, probe: async () => ({ available: false, f16: false, fallbackAdapter: null, reason: 'navigator.gpu is absent' }) } }));
  assert.equal(outcome(absent, 'webgpu_backend').outcome, 'unsupported');
  const idle = await runInferenceSelfTest(environment({ gpu: { attempted: false, initialError: null, embed: null, probe: async () => ({ available: true, f16: true, fallbackAdapter: false, reason: null }) } }));
  assert.equal(outcome(idle, 'webgpu_backend').outcome, 'attention');
  const active = await runInferenceSelfTest(environment({ route: 'webgpu-fp16', kind: 'gpu', gpu: { attempted: true, initialError: null, embed: async (text, role) => ({ vector: perturb(golden(text, role), 2e-3), route: 'webgpu-fp16' }), probe: async () => { throw new Error('not probed'); } } }));
  assert.equal(outcome(active, 'webgpu_backend').outcome, 'ok');
  assert.equal(outcome(active, 'webgpu_backend').measured.minCosineBound, SELF_TEST_THRESHOLDS.gpuFp16.minCosine);
  const drifted = await runInferenceSelfTest(environment({ route: 'webgpu-fp32', kind: 'gpu', gpu: { attempted: true, initialError: null, embed: async (text, role) => ({ vector: perturb(golden(text, role), 2e-3), route: 'webgpu-fp32' }), probe: async () => { throw new Error('not probed'); } } }));
  assert.equal(outcome(drifted, 'webgpu_backend').outcome, 'corruption');
  const lost = await runInferenceSelfTest(environment({ route: 'webgpu-fp32', kind: 'gpu', gpu: { attempted: true, initialError: null, embed: async (text, role) => ({ vector: golden(text, role), route: 'wasm-simd-fp32' }), probe: async () => { throw new Error('not probed'); } } }));
  assert.equal(outcome(lost, 'webgpu_backend').outcome, 'attention');
  assert.equal(outcome(lost, 'webgpu_backend').measured.servedBy, 'wasm-simd-fp32');
});
