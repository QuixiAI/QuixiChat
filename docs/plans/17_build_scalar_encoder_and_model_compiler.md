# 17 — Build the scalar encoder and model compiler

**Status:** Complete — scalar foundation validated; SIMD/WebGPU/scheduler and full desktop-host integration remain later plans.

**Workstream:** C1/C4 — correctness and packaging

**Depends on:** [16](./16_freeze_embedding_port_and_retrieval_benchmarks.md)

## Outcome

Implement a correct, independently runnable Arctic XS encoder and a reproducible .qxmodel compiler/loader that provide the reference foundation for both production backends.

## Product references

- [53. Query/document distinction](../product.md#53-querydocument-distinction)
- [54. QuixiEmbed architecture](../product.md#54-quixiembed-architecture)
- [55. No generic inference runtime](../product.md#55-no-generic-inference-runtime)
- [56. Model port specification](../product.md#56-model-port-specification)
- [57. Model packaging](../product.md#57-model-packaging)
- [58. Fixed graph](../product.md#58-fixed-graph)
- [59. Tokenizer](../product.md#59-tokenizer)
- [60. CPU backend](../product.md#60-cpu-backend)
- [63. Static memory planning](../product.md#63-static-memory-planning)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria)

## Tasks

- [x] Implement the verified tokenizer behavior, special tokens, truncation, padding, masks, and query/document preprocessing using the frozen port specification.
- [x] Implement the complete fixed graph in scalar code: embedding lookup, transformer layers, pooling, and output normalization. Expose stage outputs only through diagnostic/test hooks.
- [x] Create an offline compiler that verifies source hashes and tensor inventory before producing a versioned .qxmodel package with layout metadata and checksums.
- [x] Implement baseline precision/layout packing first. Add transposition, precision conversion, and quantization formats only with a corresponding correctness/retrieval test path.
- [x] Implement the model loader with explicit compatibility/integrity failures and bounded buffer ownership. Keep loading separate from inference execution and the product database.
- [x] Implement reusable workspace allocation and reserve/free lifecycle APIs. Expose embed_query and embed_document behavior without introducing a generic operator registry.
- [x] Build independent native and scalar-WASM correctness harnesses so browser interop and packaging can be checked before SIMD optimization.
- [x] Validate tokenizer output, intermediate stages, final vectors, and batch behavior against the frozen goldens and retrieval baseline.

## Deliverables and interfaces

- Scalar tokenizer/encoder, model loader, and offline model compiler within packages/quixi-embed.
- Versioned artifact format, independent build commands, and correctness harnesses.

## Acceptance criteria

- [x] Scalar outputs and tokenizer behavior pass the recorded reference gates for all fixture roles/lengths.
- [x] Repeated inference reuses bounded workspaces and releases model/work buffers correctly.
- [x] Corrupt, wrong-version, or mismatched model packages fail explicitly before inference.
- [x] The runtime builds and validates without building Quixi UI, initializing SQLite, or starting a server.

## Implementation evidence

- [The C11 runtime](../../packages/quixi-embed/native/README.md) implements the
  streaming Unicode/WordPiece tokenizer, explicit six-layer BERT graph, CLS
  pooling/L2 normalization, loaders, owned model/tokenizer data, bounded reusable
  workspace, and query/document APIs. A standalone native CLI and WASM TypeScript
  facades execute the same C graph without a generic inference runtime.
- [The versioned compiler/format](../../packages/quixi-embed/compiler/FORMAT.md)
  verifies source hashes and all 101 tensor names/shapes/content hashes before
  writing the 90,785,583-byte FP32 model package. Independent macOS and Linux CPU
  builds produce SHA-256
  `e1ef345cd35088b06f70c199f5a4e0311bda5983716ad6a3e7d0a604202efffc`.
  The separate 514,223-byte tokenizer artifact needs no model weights.
- [Both complete numerical reports](../../packages/quixi-embed/tests/reports/README.md)
  pass all 159 frozen native and scalar-WASM fixtures, including every input row
  at all batch/length combinations. Maximum absolute drift is 8.583069e-6.
  Diagnostic stage storage/exports are absent from production builds.
- Exact tokenizer parity passes 2,229,144 cases on macOS arm64 and Linux x86_64,
  covering every Unicode scalar alone/in context and seeded mixed strings.
- All 659 retrieval chunks and 18 queries pass the frozen reference comparison;
  every top-ten ranking and Recall@5/10/MRR is preserved. Maximum final-vector
  difference is 1.788139e-7. This does not select production compression.
- Production worker execution passes 16 focused edge/max-length fixtures each
  in Chromium 153, Firefox 155, and WebKit 26.6. Node API tests prove role behavior,
  limits, integrity/version rejection, idempotent wrapper disposal, and constant
  allocation across 20 repeated inferences. The measured production WASM
  workspace is 7,866,420 bytes, independent of scalar batch size.
- Five native safety tests cover digest vectors, truncated/version/identity
  failures, malformed bounds/shapes, rehashed corrupted tensors, invalid UTF-8,
  and limits. AddressSanitizer/UndefinedBehaviorSanitizer ownership/bounds checks
  pass. Seven reference/comparator and four metric tests remain passing.
- [The explicit CI provisioning command](../../packages/quixi-embed/native/README.md)
  installs the correct platform lock, downloads/verifies sources, builds every
  ignored artifact, and runs smoke gates. Linux uses a separately verified
  official `torch==2.6.0+cpu` wheel with no CUDA dependencies. `--full` runs the
  complete numerical/retrieval suite; browser provisioning is explicit.

The measured browser workers establish C/WASM interop, not Tauri/WebView2 or
Linux desktop WebKitGTK integration. Production performance optimization,
scheduler priority/cancellation, model cache/download UX, and large-index
compression remain in their assigned subsequent plans.

## Boundaries and sequencing

The compiler baseline is intentionally available before optimized backends depend on packed artifacts. Future format changes must update the compiler, loader, manifest, and goldens together. Preserve the scalar path as the long-term oracle.

[Back to the roadmap](./README.md)
