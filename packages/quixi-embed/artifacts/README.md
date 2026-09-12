# Versioned CPU WASM distribution

[1.0.0/manifest.json](1.0.0/manifest.json) names the production scalar and explicit
SIMD modules, byte sizes, SHA-256 hashes, source fingerprints, compiler image and
compatible model identity. These small modules are published with the repository;
the separately provisioned 90,785,583-byte model remains outside source control.

The runtime and model formats have separate version numbers. This distribution
uses model format v1 without weight repacking or numerical changes. Scalar requires
standard WebAssembly; SIMD additionally requires standard SIMD128. Neither module
requires WebGPU, WASM threads, SharedArrayBuffer, a native library, or numeric
JavaScript imports. The only host import reports memory growth so bindings can
recreate typed views.

The public constructors force their requested route and reject a mismatched
module. Select a compatible artifact before constructing an encoder:

```ts
import { createScalarEncoder, createSimdEncoder, supportsWasmSimd } from '@quixi/quixi-embed';

const useSimd = supportsWasmSimd();
const wasm = await (await fetch(`/assets/quixi-${useSimd ? 'simd' : 'scalar'}.wasm`)).arrayBuffer();
const model = new Uint8Array(await (await fetch('/assets/arctic-xs.qxmodel')).arrayBuffer());
const encoder = await (useSimd ? createSimdEncoder : createScalarEncoder)({ wasm, model });
try {
  const query = encoder.embedQuery('Where was the release decision recorded?');
  const documents = encoder.embedDocuments(['We agreed to release after the migration check.']);
  // Transfer the owned output arrays to the caller; numerical inference already ran in C.
} finally {
  encoder.dispose();
}
```

Run this synchronous inference API inside a dedicated worker. Applications own
asset retrieval and worker lifetimes. C validates the frozen model bytes before
inference. Disposing frees C allocations and releases the binding's instance
reference; terminating the worker provides the complete worker lifetime boundary.

Reproduce and verify all assets and this distribution using
`python3 packages/quixi-embed/native/ci.py --simd`. Add `--browsers` for real browser
workers and `--full` for the entire numerical/retrieval corpus. The pinned Docker
compiler builds WASM directly without a desktop native build prerequisite.
`native/release.py --write` explicitly replaces the local distribution during a
versioned release; its default mode only verifies the rebuilt files and manifest.
