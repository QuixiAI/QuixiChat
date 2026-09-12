import { createScalarEncoder } from '../src/scalar';
import { createSimdEncoder, supportsWasmSimd } from '../src/simd';
import { createArcticTokenizer } from '../src/tokenizer';
import type { EmbeddingRole } from '../src/scalar';
interface Fixture { id: string; text: string; role: EmbeddingRole; ids: number[]; vector: number[] }
self.onmessage = async ({ data }) => {
  const route = data.route === 'simd' ? 'simd' : 'scalar';
  try {
    const wasm = await (await fetch(`/build/quixi-${route}.wasm`)).arrayBuffer();
    const tokenizerBytes = new Uint8Array(await (await fetch('/build/arctic-xs.qxtokenizer')).arrayBuffer());
    const fixtures = (await (await fetch('/tests/browser-fixtures.json')).json()).fixtures as Fixture[];
    const tokenizer = await createArcticTokenizer({ wasm, tokenizer: tokenizerBytes });
    for (const fixture of fixtures) {
      if (JSON.stringify(Array.from(tokenizer.tokenize(fixture.text, fixture.role))) !== JSON.stringify(fixture.ids))
        throw new Error(`Tokenizer mismatch: ${fixture.id}`);
    }
    const tokenizerMemory = tokenizer.memory();
    // Model download occurs only after standalone tokenization has succeeded.
    const model = new Uint8Array(await (await fetch('/build/arctic-xs.qxmodel')).arrayBuffer());
    // Remove the API in this dedicated test worker before CPU inference.
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    if ('gpu' in navigator && (navigator as Navigator & { gpu?: unknown }).gpu !== undefined) throw new Error('WebGPU was not disabled');
    if (route === 'simd' && !supportsWasmSimd()) throw new Error('SIMD unavailable');
    const encoder = await (route === 'simd' ? createSimdEncoder : createScalarEncoder)({ wasm, model });
    const initial = encoder.memory();
    let maxError = 0;
    for (const fixture of fixtures) {
      const vector = fixture.role === 'query' ? encoder.embedQuery(fixture.text) : encoder.embedDocument(fixture.text);
      for (let i = 0; i < 384; i++) maxError = Math.max(maxError, Math.abs(vector[i]! - fixture.vector[i]!));
      if (JSON.stringify(encoder.memory()) !== JSON.stringify(initial)) throw new Error('Inference memory grew');
    }
    if (maxError > 2e-5) throw new Error(`Vector parity failure: ${maxError}`);
    encoder.dispose(); tokenizer.dispose();
    self.postMessage({ passed: true, route, backend: encoder.backend, webgpuDisabled: true, fixtures: fixtures.length, maxError, memory: initial, tokenizerMemory });
  } catch (error) {
    self.postMessage({ passed: false, error: error instanceof Error ? error.stack : String(error) });
  }
};
