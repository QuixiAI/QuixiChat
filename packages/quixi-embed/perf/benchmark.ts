/** Full production API benchmark shared by Node and dedicated browser workers. */
import { createScalarEncoder } from '../src/scalar.ts';
import { createSimdEncoder } from '../src/simd.ts';
import type { CpuEncoder } from '../src/scalar.ts';
export interface BenchmarkOptions {
  scalar: Uint8Array<ArrayBuffer>; simd: Uint8Array<ArrayBuffer>; model: Uint8Array<ArrayBuffer>;
  lengths?: number[]; batches?: number[];
  progress?: (value: unknown) => void;
}
function summary(samples: number[], batch: number, tokens: number) {
  const sorted = [...samples].sort((a,b) => a-b);
  const medianMs = (sorted[14]! + sorted[15]!) / 2;
  return { samples_ms: samples, median_ms: medianMs, p95_ms: sorted[28]!,
    chunks_per_second: batch * 1000 / medianMs, tokens_per_second: batch * tokens * 1000 / medianMs };
}
export async function benchmark(options: BenchmarkOptions) {
  const encoders: CpuEncoder[] = [], loadMs: number[] = [];
  const measurements: unknown[] = [];
  try {
    for (const [create, wasm] of [[createScalarEncoder, options.scalar], [createSimdEncoder, options.simd]] as const) {
      const start = performance.now();
      encoders.push(await create({ wasm, model: options.model }));
      loadMs.push(performance.now() - start);
    }
    const memory = encoders.map(encoder => encoder.memory());
    const start = performance.now();
    for (const tokens of options.lengths ?? [32,128,512]) for (const batch of options.batches ?? [1,4,8,16,32]) {
      const texts = Array.from({ length: batch }, (_,i) => ['token ', 'hello ', 'world ', 'model '][i%4]!.repeat(tokens-2));
      for (const encoder of encoders) for (const text of texts)
        if (encoder.tokenize(text,'document').length !== tokens) throw new Error('Benchmark token shape changed');
      const samples: number[][] = [[],[]];
      let maximumError = 0;
      for (let iteration = -5; iteration < 30; iteration++) {
        const vectors: Float32Array[][] = [[],[]];
        // Alternate baseline/candidate order, including warmups.
        for (const route of (iteration & 1) ? [1,0] : [0,1]) {
          const before = performance.now();
          vectors[route] = encoders[route]!.embedDocuments(texts);
          const elapsed = performance.now() - before;
          if (iteration >= 0) samples[route]!.push(elapsed);
          if (JSON.stringify(encoders[route]!.memory()) !== JSON.stringify(memory[route])) throw new Error('Completed jobs grew WASM memory');
        }
        // Validation is outside both timings; no vector results are cached by either encoder.
        for (let row = 0; row < batch; row++) for (let d = 0; d < 384; d++) {
          const error = Math.abs(vectors[0]![row]![d]! - vectors[1]![row]![d]!);
          if (!Number.isFinite(error) || error > 5e-5) throw new Error('Benchmark parity failed');
          maximumError = Math.max(maximumError,error);
        }
      }
      const scalar = summary(samples[0]!,batch,tokens), simd = summary(samples[1]!,batch,tokens);
      const measurement = { batch, tokens, scalar, simd, speedup: scalar.median_ms/simd.median_ms, maximum_vector_error: maximumError };
      measurements.push(measurement);
      options.progress?.({ status:'running', warmups:5, samples:30, load_ms:loadMs, memory, measurements, elapsed_seconds:(performance.now()-start)/1000 });
    }
    return { status:'passed', warmups:5, samples:30, load_ms:loadMs, memory, measurements,
      elapsed_seconds:(performance.now()-start)/1000, timing_scope:'Production UTF-8 input transfer, tokenizer, complete encoder, normalized FP32 output copy; validation outside timing',
      cold_load_scope:'First instance compilation/instantiation, frozen model validation/copy, workspace allocation; asset retrieval reported separately',
      batch_policy:'Serial documents share one 512-token workspace; no cross-document padding or parallel execution' };
  } finally { for (const encoder of encoders) encoder.dispose(); }
}
