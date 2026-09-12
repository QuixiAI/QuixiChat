# 0003 — Freeze Arctic XS and use C for the CPU port

Date: 2026-09-08. Status: accepted for the port contract and CPU language.

[Product sections 51–60](../product.md#51-semantic-model) require a fixed,
owned text encoder. Freeze Snowflake Arctic XS revision
`d8c86521100d3556476a063fc2342036d45c106f` and the hashes in
[the source lock](../../packages/quixi-embed/reference/source-lock.json).
The inspected checkpoint has six BERT layers, 384-dimensional CLS pooling,
exact GELU, learned absolute positions, and a query-only prefix. Gemma numerical
semantics do not carry over.

Use C11 for native scalar diagnostics and WASM SIMD, with explicit buffer lengths
and one flat ABI. C has a direct path to Emscripten SIMD intrinsics and makes
stage-by-stage comparison with an independent PyTorch oracle straightforward.
The nearby embeddinggemma.c project provides relevant C numerical and scheduling
experience. Rust remains appropriate for the Tauri host; the host must not become
a numerical dependency. No evidence establishes that C is faster than Rust, and
that is not the reason for this choice.

[The toolchain evidence](../../packages/quixi-embed/reference/toolchain-evidence.json)
records native compilation and execution of the same four-element dot source,
a pinned Emscripten Docker build with `-msimd128`, and Node WebAssembly execution
through linear memory with result 70. This proves the basic build/interop path,
not inference performance or browser compatibility. Apple clang alone on this
machine has no wasm32 target; use the pinned Docker SDK rather than assuming the
system compiler is sufficient. Runtime code must check buffer bounds, allocation
overflow, token limits, and nonfinite output; C does not provide those checks.

Reference tooling is offline-only, with pinned Python packages, revision-addressed
public source downloads, full artifact hashes, and stage/final goldens. Production
code receives compiled model data and executes the fixed graph without importing
PyTorch, Transformers, ONNX, or a generic operator registry.

## Lessons from embeddinggemma.c

Reviewed `/Users/eric/embeddinggemma.c/CONTRIBUTING.md` (Runtime And Serving),
`perf/README.md` (Server Comparisons), and `perf/optimization_status.md` (rejected
order-sensitive CPU scheduling experiments). These are local reference materials,
not a dependency or a source of Arctic model defaults.

- Bound admission, queued requests, sequence length, and batch token totals
  independently. Reserve backend workspace before admitting inference work.
- Cache complete vectors using exact token IDs and the full model/role identity;
  coalesce concurrent duplicates. Do not cache transformer prefixes for a
  bidirectional encoder because later tokens change earlier hidden states.
- Separate execution from scheduling and cancellation. Interactive priority
  takes effect between bounded executions, not by pretending a GPU kernel can
  be preempted arbitrarily.
- Separate cold load, warm execution, cache hits, serialization, and transfer
  when benchmarking. Alternate candidate/baseline order to expose thermal drift.
- Keep numerical and relevance gates independent of throughput. A narrow warm
  timing win or a synthetic corpus score cannot justify a production optimization.

No HTTP serving, Metal implementation, Gemma tokenizer, rotary positions, or
Gemma-specific pooling is copied into the Arctic runtime.

## WebGPU execution decision — 2026-09-08

[Product sections 61–67](../product.md#61-webgpu-backend) are implemented by
[owned WGSL sources](../../packages/quixi-embed/kernels/webgpu/1.0.0/manifest.json)
and an explicit device/workspace owner. The model package remains version 1;
WebGPU kernel distribution 1.0.0 verifies exact shader identities before use.
The C tokenizer remains independent of CPU model allocation. No numerical
JavaScript, ONNX/WebGPU inference runtime or per-layer host transfer is involved.

Use FP32 as the diagnosable baseline. WGSL permits floating-point reassociation
and fusion, and provides no `erf` builtin; enforce the frozen numerical gates
instead of promising bit identity. The fixed GELU uses the Abramowitz–Stegun
7.1.26 error-function approximation, checked against independent FP64 fixtures
and all frozen hidden stages. FP16 projections explicitly opt into `shader-f16`,
use FP16 operands/products with FP32 accumulation, and retain FP32 normalization,
softmax, residual operations and final vectors. These choices follow the
[WGSL floating-point rules](https://www.w3.org/TR/WGSL/#floating-point-evaluation)
and [NIST's mathematical handbook](https://www.nist.gov/mathematics-statistics/handbook-mathematical-functions-abramowitz-and-stegun).

Retain tiled projections where device-local measurements favor them. The small
batch/token baseline remains useful; forced tiling regressed batch 1/32 tokens on
this host. Fused FP32 attention keeps probabilities in workgroup memory and avoids
the quadratic scores buffer. FP16 remains an explicit optional route, with both
quality and shape-dependent performance evidence. Do not enable subgroup
normalization publicly: its numerically valid experiment showed timing regressions.
See the [raw paired evidence and selection limits](../../packages/quixi-embed/perf/results/2026-09-08-gpu-development-load/README.md).

One instance owns one device/queue and a fixed allocation plan. A batch completes
before another is admitted; `busy` is observable rather than hidden behind an
unbounded queue. Device loss or execution failure destroys owned resources and
rejects incomplete vectors. The product scheduler chooses CPU fallback, retries
and publication eligibility; the encoder cannot write canonical history. Feature
requests are explicit and `GPUDevice.lost` is observed, as specified by the
[WebGPU device contract](https://gpuweb.github.io/types/interfaces/GPUDevice.html).

Bounded autotuning compares FP32 projections, requires a 10% selection margin,
and admits at most 24 graph probes within a 750 ms admission window. An optional
storage-owner cache adapter persists validated records under model, GPU runtime,
shader, adapter, feature/limit, browser and capacity identities. The runtime opens
no database. See the [resource and scheduler interface](../../packages/quixi-embed/src/gpu/README.md).

The hardware evidence covers one Apple M5 Max through Chromium and WebKit.
It does not establish support or relative performance on another GPU family,
software adapters, default headless Chromium without GPU flags, or Firefox's
unavailable adapter. Development host load and driver-private memory limitations
are retained in the reports. Wider hardware coverage, scheduler preemption and
large-index production readiness remain separate release/integration gates.

## Scheduler integration and CPU 1.0.1

Plan 20 adds strict C token preflight with a count saturating at 513 and the owned
SHA-256 export. The frozen CPU distribution advances to 1.0.1; model format v1,
compiled model hash, scalar/SIMD arithmetic and GPU distribution 1.0.0 remain
unchanged. Legacy truncating tokenization remains available, while scheduler
admission rejects oversized input. A stable model-owned tokenizer supports
preflight during GPU disposal and CPU fallback. Full source offsets are still a
separate chunker integration gate.

The [scheduler contract](../../packages/quixi-embed/src/scheduler/README.md) fixes
priority at dispatch boundaries, bounded jobs/text/consumers/cache/storage calls,
per-consumer cancellation and storage-owned durable publication. CPU work yields
a task after each complete graph; GPU backgrounds default to four requests and
2,048 padded tokens. The [recorded evidence](../../packages/quixi-embed/tests/reports/scheduler-2026-09-08/README.md)
includes all 159 native/scalar/SIMD cases, 397 independent preflight fixtures,
18 deterministic tests, and 12 actual browser scenarios. One Apple GPU family
and shared development-load timing do not close the broader plan 19 release matrix.
