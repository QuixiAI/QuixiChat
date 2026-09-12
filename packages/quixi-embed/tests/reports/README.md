# CPU implementation evidence

Measured on 2026-09-08. These reports validate plan 17's fixed scalar foundation;
the scalar reports do not approve SIMD/WebGPU optimizations, scheduler behavior, compression,
or complete desktop-host compatibility. Generated model/diagnostic WASM binaries and full candidate arrays remain ignored
build artifacts, with identities recorded here. Production scalar/SIMD WASM
distributions are tracked separately under `artifacts/1.0.0`.

| Evidence | Coverage | Result |
| --- | --- | --- |
| [Native numerical parity](native-parity-report.json) | All 159 fixtures, every input row executed; diagnostic C build | Pass; maximum stage/pooled/vector absolute error 8.583069e-6 |
| [Scalar WASM parity](wasm-parity-report.json) | All 159 fixtures, every input row executed in Node WebAssembly | Pass; maximum absolute error 8.583069e-6 |
| [Unicode parity](unicode-report.json) | 2,229,144 comparisons: all Unicode scalars alone/in words, focused cases, 5,000 seeded mixed strings | Exact tokenizer match |
| [Native retrieval](native-retrieval-report.json) | All 659 corpus chunks and 18 queries through C | No changed top-ten rankings; maximum vector error 1.788139e-7 |
| [Production WASM API](scalar-api-report.json) | Node; roles, bounds, integrity/version failure, disposal, 20 repeated inferences | Pass; fixed allocation, no diagnostic exports |
| [Browser workers](browser-report.json) | Chromium 153, Firefox 155, WebKit 26.6; 16 edge/max-length fixtures per engine | Pass; maximum vector error 1.490116e-7; fixed memory |
| [Linux CPU environment](linux-environment-report.json) | Python 3.11.15 / torch 2.6.0+cpu in Linux x86_64 container; no CUDA; compiler and four full reference cases | Pass; byte-identical model artifact and reference tolerance |

The complete native/WASM parity runs used the diagnostic artifact identities
recorded in their reports. Production loader/tokenizer-only exports were added
alongside that graph; their C encoder and tokenizer source hashes match the
numerically validated sources. Production artifacts are separately tested through
the actual TypeScript C ABI in Node and all three browser engines. Build manifests
record the precise source fingerprints and diagnostic/production distinction.

Native tests also passed known SHA-256 vectors, truncated/wrong-version/source
packages, out-of-bounds records, wrong tensor shapes, rehashed corrupted weights,
UTF-8 errors, and token/input/workspace limits. The ownership/bounds executable
passed AddressSanitizer and UndefinedBehaviorSanitizer with ten repeated forward
passes and complete free lifecycles. These sanitizer tests are separate from
numerical thresholds; measured memory does not by itself prove memory safety.

The browser tests run the scalar runtime in real dedicated workers. They do not
validate Tauri/WebView2, Linux desktop WebKitGTK, storage ownership, or complete
Quixi UI behavior. Linux environment checks were run in the pinned
`python:3.11.15-slim` image at digest
`sha256:90744cff8f32887f075c47d747a173ff333e9e98801667af93c357fa9f5e28ff`.
Reference CPU differences from the macOS oracle remained inside the frozen gates.

Reproduce/provision via [native/README.md](../../native/README.md). CI's smoke
entry provisions every ignored artifact before tests. Full numerical runs are
explicitly available through `native/ci.py --full`; they are not replaced by the
small browser fixture set.

## SIMD implementation evidence

Plan 18 uses the same v1 model artifact, tokenizer and bounded workspace. The
tracked [versioned production distribution](../../artifacts/1.0.0/manifest.json)
is separate from diagnostic modules used for intermediate-stage extraction.

| Evidence | Coverage | Result |
| --- | --- | --- |
| [Kernel parity](kernel-parity.json) | Dot and weighted-value accumulation; 2,400 scalar/SIMD comparisons over fixed graph widths, varying magnitudes, and unaligned float offsets | Exact FP32 identity |
| [Upstream numerical parity](simd-parity-report.json) | All 159 cases, including mixed/padded batches and length boundaries | Pass; maximum error 8.583069e-6 |
| [Scalar/SIMD full parity](simd-scalar-parity-report.json) | Every saved scalar WASM case compared with actual SIMD execution | Maximum error 0.0 |
| [SIMD retrieval](simd-retrieval-report.json) | All 659 chunks and 18 queries through production TypeScript/C WASM | No changed top-ten rankings; maximum vector error 1.788139e-7 |
| [Production SIMD API](simd-api-report.json) | Explicit route identity, roles, limits, corruption rejection, disposal, 20 repeated calls | Pass; unchanged ownership and no diagnostic exports |
| [Browser workers](simd-browser-report.json) | Chromium 153, Firefox 155, WebKit 26.6 with WebGPU API disabled; 16 fixtures each | Pass; maximum vector error 1.490116e-7 |
| [Allocator observation](simd-allocator-report.json) | Same production sources plus one observer export; model load, workspace, 20 forwards, disposal | Peak 182,016,928 bytes; steady 100,149,952; zero live C allocations after disposal |
| [Retained memory](simd-memory-report.json) | 2,000 production API jobs after 100 warmups, test-only GC | Fixed 183,107,584-byte WASM memory; retained JS heap within 2 MiB bound |
| [Independent SIMD CI](ci-simd-report.json) | Provision model, both WASM routes, kernel gates, distribution verification, production API and browser tests | Pass; no desktop native compiler/library required |

The [archived development-load benchmark](../../perf/results/2026-09-08-development-load/README.md)
passes the full Chromium matrix and short Firefox/WebKit comparisons with
1.87–2.11× median speedups. Those raw results include concurrent development load
and do not establish quiescent or release-grade latency. The allocator observer
[build manifest](quixi-simd-memory.wasm.json) records its distinct artifact identity;
production throughput uses the versioned modules without observation exports. Browser evidence applies to
these engines on macOS arm64; actual Windows/Linux devices, Tauri/WebView2, and
WebKitGTK host integration remain separate release-matrix work.

## Scheduler and CPU 1.0.1 evidence

[Plan 20 evidence](scheduler-2026-09-08/README.md) records strict overflow/digest
preflight, full native/scalar/SIMD recertification, bounded scheduling, sustained
admission/cache checks, actual three-engine CPU workers and Apple GPU loss
recovery. Historical 1.0.0 reports above remain unchanged.

## Original-source offsets and CPU 1.0.2 evidence

[Offset evidence](offsets-2026-09-08/README.md) records the bounded standalone
UTF-8/UTF-16 contributor API, 870 focused cases with explicit upstream alignment
exceptions, 2,412 exhaustive grouped cases, native safety and stack accounting,
six actual browser workers, full numerical recertification and scheduler
compatibility with CPU 1.0.2. Earlier distributions and evidence remain intact.
