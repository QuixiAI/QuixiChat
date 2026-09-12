# 19 — Build and optimize the WebGPU backend

**Status:** Implemented and validated on Apple M5 Max through Chromium/Metal and WebKit. A wider GPU-family release matrix remains open.

**Workstream:** C3 — optional accelerated inference

**Depends on:** [17](./17_build_scalar_encoder_and_model_compiler.md)

## Outcome

Execute the complete fixed encoder on WebGPU with persistent weights, bounded scratch memory, and validated acceleration over the fallback where hardware supports it.

## Product references

- [54. QuixiEmbed architecture](../product.md#54-quixiembed-architecture)
- [61. WebGPU backend](../product.md#61-webgpu-backend)
- [62. GPU residency](../product.md#62-gpu-residency)
- [63. Static memory planning](../product.md#63-static-memory-planning)
- [64. Kernel specialization](../product.md#64-kernel-specialization)
- [65. Kernel fusion](../product.md#65-kernel-fusion)
- [66. Execution routes](../product.md#66-execution-routes)
- [67. Autotuning](../product.md#67-autotuning)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [113. QuixiEmbed benchmarks](../product.md#113-quixiembed-benchmarks)
- [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria)

## Tasks

- [x] Implement and validate an FP32 baseline for every required model-specific WGSL kernel before introducing reduced precision or fusion.
- [x] Implement persistent GPU weight buffers and static scratch allocation at model initialization. Keep intermediate tensors GPU-resident through the full graph.
- [x] Use one final vector readback after encoder execution. Measure input upload, dispatch, and output readback separately from kernel execution.
- [x] Add FP16 and optional feature/subgroup routes with explicit capability detection, numerical gates, and per-device performance evidence.
- [x] Profile and evaluate kernel specialization/fusion only where measurements justify it. Preserve a diagnosable baseline path for parity testing.
- [x] Implement bounded autotuning and cache the chosen variants by device/runtime/kernel identity. Invalidate tuning when any relevant identity changes.
- [x] Handle initialization failure, device loss, memory limits, and execution errors by reporting backend availability and allowing the product scheduler to use the CPU fallback.
- [ ] Complete the representative GPU-family benchmark matrix. Available hardware is measured: all required batch sizes, full query/backfill work, features and owned allocation peaks pass on one Apple M5 Max through two browser engines. Other GPU families remain unverified.

## Deliverables and interfaces

- Versioned WGSL kernels, WebGPU execution/memory planning, and backend capability/error reporting.
- FP32/FP16 parity tests, tuning records, and measured backend reports.

## Acceptance criteria

- [x] FP32 and enabled optimized routes pass the frozen numerical and retrieval gates.
- [x] Intermediate activations remain on GPU and steady-state execution allocates no new scratch buffers.
- [x] Device loss/failure is surfaced without corrupting canonical history or treating an incomplete embedding as valid.
- [x] Optional features are performance routes; missing them does not eliminate the WASM fallback.

## Implementation evidence

- [GPU runtime contract](../../packages/quixi-embed/src/gpu/README.md) and
  [versioned shader/runtime manifest](../../packages/quixi-embed/kernels/webgpu/1.0.0/manifest.json):
  full owned FP32 graph, tiled/optional FP16 projection, fused FP32 attention,
  persistent weights, static scratch, one production vector readback and typed
  initialization/loss/execution failures. Model package format remains version 1.
- [Final hardware suite and raw reports](../../packages/quixi-embed/tests/reports/gpu-2026-09-08/README.md):
  115 commands passed; 83 independent kernel cases per route; all seven retained
  combinations each pass 159 original plus 30 tile-boundary graph cases in both
  engines (2,646 graph executions). Every forced combination passes the
  659-chunk/18-query retrieval gate with unchanged top-ten rankings.
- Both real-adapter lifecycle tests complete 500 jobs without another GPU buffer
  allocation, then verify device loss, pending disposal, cleanup and actual SIMD
  fallback. Observed B4/max512 auto/fused peak is 121,780,240 owned GPU bytes;
  driver-private memory is not observable. Admission failure is tested separately
  with an injected allocation failure, without claiming a real OOM experiment.
- Bounded autotuning admits at most 24 probes/750 ms, requires a 10% selection
  margin and uses a validated, identity-keyed storage-owner cache adapter. The
  runtime opens no database. Tests cover corrupt/stale records, failed/timed-out
  cache calls, bounded probes, cache reuse and copied records.
- [Paired performance and transfer observations](../../packages/quixi-embed/perf/results/2026-09-08-gpu-development-load/README.md):
  B1/4/8/16/32 at T32/128/512, five warmups and 30 alternating samples per route.
  Final auto/fused improves or ties the baseline across both engines. Direct
  B1 SIMD anchors show 9.26–49.16× Chromium and 9.50–38.24× WebKit acceleration.
  Host upload/dispatch, completion/readback, instrumented GPU timestamps and
  separately synchronized map/copy observations have explicit distinct meanings.
- Subgroup normalization remains a rejected internal experiment because it
  regressed measured shapes. FP16 is explicitly selected: it improves/ties larger
  measured shapes but regresses B1/T32 against auto FP32. No universal FP16 speed
  claim or automatic FP16 selection is made.
- [Reproduction entry](../../packages/quixi-embed/tests/gpu/README.md):
  `python3 packages/quixi-embed/native/gpu_ci.py --full --engines chromium webkit`.
  Provisioning uses the existing supported Linux CPU-only/macOS reference locks
  and pinned WASM build. Missing or software-only adapters cause a nonzero exit.
  A failed terminal browser-closure replay is preserved beside the successful
  rerun; CI cannot leave a stale passed report.

## Remaining release/integration gates

The measurements cover one physical GPU family and a shared development host.
Wider GPU/OS/driver coverage and a controlled release replay remain open; no
software-only result is represented as hardware support. Fresh-instance load
measurements use already-fetched assets and do not clear driver/OS caches.
Plan 20 owns priority, cancellation and retry scheduling. Plan 21/storage own
vector/checkpoint publication and durable resume. Source offsets and an
untruncated tokenizer interface remain a separate chunker integration gate.
These results do not complete all product-section 117 production-readiness criteria.

## Boundaries and sequencing

Plan 18 is not a prerequisite for developing kernels, but the integrated product requires its fallback. Do not transplant native Metal/CUDA optimizations solely because they worked in embeddinggemma.c; measure WebGPU behavior on its actual hosts.

[Back to the roadmap](./README.md)
