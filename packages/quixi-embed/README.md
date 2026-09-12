# @quixi/quixi-embed

Owned Arctic XS tokenizer, fixed C scalar/SIMD encoder, model compiler/loader, and
WASM API. [PORT_SPEC.md](PORT_SPEC.md) freezes the source, graph, tokenizer,
query/document roles, and correctness gates. Owned WebGPU and bounded scheduling
use the retained scalar implementation as their numerical oracle.

- [Native/WASM build and CI](native/README.md): independently build and run the
  C library/CLI or production WASM; provision all required artifacts explicitly.
- [Model format/compiler](compiler/README.md): deterministic FP32 `.qxmodel`
  and tokenizer-only `.qxtokenizer` with frozen integrity/compatibility checks.
- [Public scalar API](src/scalar.ts): query/document embeddings, bounded serial
  batches, explicit memory ownership/disposal; numerical work stays in C WASM.
- [SIMD API](src/simd.ts): explicit CPU SIMD route and capability detection;
  uses the same validated model and memory contract as scalar.
- [Versioned WASM distribution](artifacts/1.0.2/manifest.json): production scalar
  and SIMD artifacts with reproducible source/build checksums.
- [WebGPU runtime](src/gpu/README.md): owned graph, adapter diagnostics, explicit
  loss behavior, and measured FP32/half routes.
- [Bounded scheduler](src/scheduler/README.md): priority, cancellation, strict token
  preflight, private cache injection, CPU task yielding, and GPU fallback.
- [CPU measurements](perf/README.md): profiling and paired full-encoder benchmarks.
- [Standalone tokenizer API](src/tokenizer.ts): usable without model weights;
  [original-source offsets](src/TOKEN_OFFSETS.md) preserve UTF-8/UTF-16 provenance
  with explicit capacity bounds and documented upstream alignment exceptions.
- [Reference reproduction](reference/README.md): offline pinned source and
  environment, 159 golden cases, inventory, and strict numerical comparison.
- [Validation evidence](tests/reports/README.md): native/scalar-WASM parity,
  exhaustive Unicode, retrieval, memory, package failure, and browser-worker tests.
- [Retrieval benchmark](../../perf/retrieval/README.md): independent corpus,
  judgments, coarse/exact metrics, and preliminary performance baseline.
- [Chunk tokenizer adapter](src/chunking.ts): source-offset spans plus exact
  admission checks for the product chunker; no weights or inference.
- [Embedding service](src/service/): a dedicated worker around the scheduler that
  fetches pinned assets by URL + SHA-256, caches the verified model in OPFS,
  selects WebGPU/SIMD/scalar and exposes an RPC client (`createEmbeddingService`).
- [Model lock](artifacts/model/lock.json): the pinned model/tokenizer/WASM/kernel
  identities; `src/lock.ts` mirrors it for code and a test keeps them equal.

Use the CPU APIs in a dedicated worker. `src/worker/` exports the independent
scheduling service; the app owns RPC and durable publication. Offline PyTorch/Transformers tools are
never browser runtime dependencies. Downloads and intermediate binaries stay under
ignored `build/`; the small versioned production WASM distribution and the
514 KB tokenizer artifact under `artifacts/` are tracked; source contracts,
hashes, fixtures, and evidence are tracked. The 90.8 MB compiled model is a
provisioned host asset (`build/arctic-xs.qxmodel`, served under `/models/`),
verified against the lock before every use.
