/** Model-specific CPU fallback. All numerical work remains inside C/WASM. */
import { createCpuEncoder } from './scalar.ts';
import type { SimdEncoder } from './scalar.ts';

/** Validate a minimal standard SIMD v128.const module, without executing it. */
export function supportsWasmSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,
      253,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,11,
    ]));
  } catch { return false; }
}

/** Explicit route: unsupported hosts or scalar artifacts produce an error.
 * Run synchronous inference on a dedicated worker, and dispose its owned memory.
 */
export function createSimdEncoder(options: {
  wasm: BufferSource | WebAssembly.Module; model: Uint8Array;
}): Promise<SimdEncoder> {
  if (!supportsWasmSimd()) return Promise.reject(new Error('WASM SIMD is unsupported'));
  return createCpuEncoder('wasm-simd-fp32', options);
}
