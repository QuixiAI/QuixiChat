# 18 — Optimize the WASM SIMD backend

**Status:** Completed — SIMD correctness, retrieval, memory, browser, distribution and measured performance gates pass. Timing evidence is explicitly limited to development load on the exercised host and engines.

**Workstream:** C2 — universal semantic fallback

**Depends on:** [17](./17_build_scalar_encoder_and_model_compiler.md)

## Outcome

Provide a production WASM SIMD encoder that remains numerically validated and usable wherever the supported host lacks WebGPU.

## Product references

- [60. CPU backend](../product.md#60-cpu-backend)
- [63. Static memory planning](../product.md#63-static-memory-planning)
- [66. Execution routes](../product.md#66-execution-routes)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [113. QuixiEmbed benchmarks](../product.md#113-quixiembed-benchmarks)
- [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria)

## Tasks

- [x] Implement model-specific SIMD kernels for the frozen graph, prioritizing operations identified by scalar profiling rather than adding a general tensor library.
- [x] Preserve a selectable scalar path and verify each new kernel before enabling it in complete inference.
- [x] Implement the browser/WASM binding, explicit memory ownership, input transfer, workspace reuse, and normalized output transfer required by an embedding worker.
- [x] Validate batch/sequence shape handling, padding/masks, ragged work sizes, and maximum input behavior against scalar and upstream reference outputs.
- [x] Benchmark cold load, warm latency, chunks/tokens per second, memory, and batch sizes 1/4/8/16/32 on representative supported hosts.
- [x] Retain optimizations only when numerical gates, retrieval quality, and measured performance all support them. Record rejected experiments and relevant device/runtime conditions.
- [x] Publish a versioned, checksummed WASM artifact and a reproducible build/verification command that does not require desktop native code.

## Deliverables and interfaces

- WASM SIMD backend, independent scalar/SIMD parity tests, and reproducible artifacts.
- Backend capability detection and measured batch/memory guidance for the scheduler.

## Acceptance criteria

- [x] The SIMD backend passes tokenizer, stage/final-vector, batch, and retrieval gates across exercised shapes.
- [x] Semantic inference works on a supported host with WebGPU disabled.
- [x] Steady-state inference does not grow memory with completed job count.
- [x] Reported performance includes full encoder and interop overhead, not only isolated kernels.

## Implementation and measured evidence

- [The fixed-width C kernels](../../packages/quixi-embed/native/kernels.h) use
  explicit WASM SIMD128 dot and weighted-value accumulation. The
  [scalar profile](../../packages/quixi-embed/perf/scalar-profile.json) identified
  dense projections and long-sequence attention as the primary costs. Four-lane
  summation order and FP32 multiply/add semantics remain identical to scalar.
  Exact erf GELU, FP64 LayerNorm statistics and scalar softmax are retained.
- [Kernel tests](../../packages/quixi-embed/tests/reports/kernel-parity.json)
  cover 2,400 comparisons, graph widths and unaligned float offsets. The
  [full SIMD run](../../packages/quixi-embed/tests/reports/simd-parity-report.json)
  executes every row of all 159 upstream fixtures: maximum absolute error
  `8.58306884765625e-6`, minimum cosine `0.9999999999996364`.
  [Comparison with scalar WASM](../../packages/quixi-embed/tests/reports/simd-scalar-parity-report.json)
  has maximum error `0.0` across every saved array.
- [Production retrieval](../../packages/quixi-embed/tests/reports/simd-retrieval-report.json)
  embeds all 659 chunks and 18 queries, preserves every top-ten ranking and all
  frozen retrieval metrics, and has maximum vector error `1.7881393432617188e-7`.
  This remains the explicitly limited synthetic corpus from plan 16.
- [The forced SIMD API](../../packages/quixi-embed/src/simd.ts) and scalar API
  verify the C backend identity, own/dispose their instance and reuse one
  7,866,420-byte workspace. [Browser workers](../../packages/quixi-embed/tests/reports/simd-browser-report.json)
  pass 16 edge/max-length fixtures in Chromium 153, Firefox 155 and WebKit 26.6
  on macOS arm64 with the WebGPU API disabled. Maximum vector error is
  `1.4901161193847656e-7`; completed calls do not grow linear memory.
- [Version 1.0.0 distribution](../../packages/quixi-embed/artifacts/1.0.0/manifest.json)
  publishes checksummed production scalar and SIMD modules in the repository.
  Model format v1 and the frozen model bytes are unchanged. There is no external
  registry/CDN upload. `python3 packages/quixi-embed/native/ci.py --simd --browsers`
  provisions and verifies this work without a desktop native compiler/library;
  `--full` adds all numerical/retrieval cases.
- [The full-encoder benchmark](../../packages/quixi-embed/perf/results/2026-09-08-development-load/README.md)
  measures production interop, first-instance load, raw latency samples,
  median/p95, throughput and memory. Chromium completed all 15 shapes
  (B1/4/8/16/32 × T32/128/512), with 1.87–2.04× median speedups. Firefox and WebKit
  each completed the five T32 batch shapes, with 2.08–2.11× and 2.02–2.04× speedups.
  Each shape has five warmups and thirty alternating samples per route; every
  output matched scalar exactly. On the measured Apple M5 Max, Chromium's B1/T512
  SIMD median/p95 was 678.3/688.2 ms and first-instance SIMD load was 515.5 ms,
  excluding asset retrieval. These runs overlapped frontend/TypeScript builds,
  browser tests and Cargo compilation. The archived raw reports and conditions
  are directional development-load evidence; no quiet-host or release-grade
  timing claim is made. A controlled replay remains separate release validation.
- [Allocator observations](../../packages/quixi-embed/tests/reports/simd-allocator-report.json)
  measure 182,016,928 peak live bytes, 100,149,952 steady live bytes and zero live
  C allocations after disposal, using unchanged production sources plus one
  observation export. [A 2,000-job API run](../../packages/quixi-embed/tests/reports/simd-memory-report.json)
  maintains fixed 183,107,584-byte WASM memory and bounded retained JS heap after
  test-only GC. Neither result measures caller-retained outputs or OS RSS.
- The [benchmark notes](../../packages/quixi-embed/perf/README.md) record the
  profiling choices and initial dot-only prototype, which has no separate
  performance claim. The retained dot/attention kernels pass numerical,
  retrieval and measured speed gates. CPU batches remain serial: the plan 20
  scheduler should yield between documents so priority queries can run.

Actual Windows/Linux devices, Tauri/WebView2 and desktop WebKitGTK are not covered
by these browser-worker checks. Their full host integration belongs to the later
release matrix; no cross-device latency or memory claim is inferred here.

## Boundaries and sequencing

The WebGPU backend in plan 19 can be developed independently after plan 17. SIMD remains the production CPU fallback; scalar remains the correctness oracle. Hardware-specific tuning must not change the frozen query/document semantics.

[Back to the roadmap](./README.md)
