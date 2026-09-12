# Scheduler and CPU artifact 1.0.1 evidence

Plan 20 implements the independent inference service. App RPC, persisted indexing
checkpoints, private durable cache policy and producer-generation publication
remain the owning application's integration work. This evidence does not claim
that inference completion is durable indexing completion.

The final [provisioned CI run](scheduler-ci-report.json) passed all **22 wrapper
commands**, including [the nested CPU provisioner](ci-simd-report.json). It used
the pinned Docker Emscripten image, the verified macOS arm64 reference lock,
public artifact checksums and actual browser workers. The supported Linux entry
selects the separately verified CPU-only Linux lock; this scheduler replay was
performed on macOS, not a Linux or Windows machine. The earlier
[21-command run with existing assets](preprovision/scheduler-ci-report.json) and
[original browser matrix log](initial-browser-matrix.log) are preserved separately.

## Correctness and bounded resources

| Evidence | Coverage and outcome |
| --- | --- |
| [Deterministic scheduler tests](scheduler-tests.tap) | 18 passed: priority promotion, padded batching, real task yielding, pause/resume/drain, independent joiner cancellation, saturation, identity/role separation, copied cache, aging, loss retry, abandoned output rejection, bounded hung storage, corrupt cache, ETA scope, shutdown and malformed output |
| [Sustained resource report](scheduler-resource-report.json) | 5,120 unique backfill jobs plus one shared inference; 5,000 excess duplicate consumers and 160 excess unique admissions rejected. Peaks: 32 jobs, 32 consumers, 75,906 admission bytes, 16 vectors / 35,264 cache bytes. Final jobs/consumers/admission bytes zero |
| [Strict token preflight](token-preflight-report.json) | 397 independently generated untruncated upstream cases on scalar/SIMD, both standalone and model tokenizers; exact UTF-8 SHA/count/overflow and historical truncated IDs. Legacy 1.0.0 inspection rejected explicitly |
| [Native full parity](scheduler-native-parity.json) | All 159 frozen cases; every stage/pooled/vector comparison passed |
| [Scalar WASM full parity](scheduler-scalar-parity.json) | All 159 frozen cases; every stage/pooled/vector comparison passed |
| [SIMD full parity](scheduler-simd-parity.json) | All 159 frozen cases; every stage/pooled/vector comparison passed |
| [Production scalar API](scalar-api-report.json), [SIMD API](simd-api-report.json) | Actual C WASM route, integrity/bounds/disposal and 20 repeat calls; no diagnostic exports |
| [Retained CPU memory](simd-memory-report.json) | 2,000 actual inference jobs after 100 warmups; fixed 183,107,584-byte linear memory and retained JS heap within the 2 MiB test bound |

The controlled-executor resource test measures scheduler accounting, not real
model performance or OS RSS. Its generated unit vectors are test substitutes;
the separate browser scenarios execute the actual C/WGSL model. Caller-retained
vectors and storage-engine memory remain outside inference service ownership.
Timed-out underlying storage calls retain their permits, verified with unresolved
promises; no unbounded retry queue is created behind the timeout.

Each of the **12 actual browser scenarios** verifies all 397 strict preflight
fixtures, 12 short frozen model vectors, 32 duplicate consumers with one cancelled
joiner, exact-512 acceptance, overflow rejection, and insertion of a query ahead
of queued 512-token backgrounds. CPU routes also test initial GPU-unavailability
fallback with an explicitly injected unavailable factory. Actual GPU-loss tests
destroy the device during an in-flight graph, retry via real SIMD and verify
priority selection after recovery. Successful real GPU initialization is required;
fallback/software adapters are rejected by the hardware gate.

| Engine | Scalar | SIMD | GPU FP32 | GPU half | In-flight GPU loss to SIMD |
| --- | --- | --- | --- | --- | --- |
| Chromium 153.0.8010.12 | [Pass](scheduler-chromium-scalar.json) | [Pass](scheduler-chromium-simd.json) | [Pass](scheduler-chromium-gpu.json) | [Pass](scheduler-chromium-half.json) | [Pass](scheduler-chromium-gpu-loss.json) |
| Firefox 155.0 | [Pass](scheduler-firefox-scalar.json) | [Pass](scheduler-firefox-simd.json) | Not run | Not run | Not run |
| WebKit 26.6 | [Pass](scheduler-webkit-scalar.json) | [Pass](scheduler-webkit-simd.json) | [Pass](scheduler-webkit-gpu.json) | [Pass](scheduler-webkit-half.json) | [Pass](scheduler-webkit-gpu-loss.json) |

## Dispatch timing and environment

These are short correctness-scenario observations on **Apple M5 Max, macOS
26.6.2 / Darwin 25.6.0 arm64**, with concurrent native/scalar/SIMD reference
computation and development activity. They are not quiescent, statistically
powered latency benchmarks. Reports contain actual browser versions, adapter
features/limits, launch flags, resource capacities and execution sequences. The
GPU adapters report Apple hardware and `isFallbackAdapter: false`; Chromium uses
the recorded headless GPU/Metal flags. There is only one GPU family here.

| Final provisioned scenario | Background dispatch at 512 tokens | Query dispatch at 10 tokens |
| --- | ---: | ---: |
| Scalar, three engines | 1,508–1,815 ms, batch 1 | 22.5–27 ms |
| SIMD, three engines | 711–775.8 ms, batch 1 | 12–13.6 ms |
| GPU FP32, Chromium/WebKit | 24.8–40 ms, batch 4 | 1.8–2 ms |
| GPU half, Chromium/WebKit | 24–40 ms, batch 4 | 2.6–4 ms |

Dispatch timings exclude queue wait and backend initialization. Device-loss
scenario timings are not used as successful GPU throughput measurements. Each
query runs at the next eligible boundary after the worker receives it; an active
C graph blocks that worker until completion and cannot be interrupted. Renderer
10 ms heartbeat observations continued throughout all scenarios, with maximum
observed gaps of 11.1–17 ms in the final run. This is renderer responsiveness
evidence, not a guarantee of immediate query processing inside the CPU worker.

GPU capacity is batch 4 / 512 tokens: **121,780,240 GPU-buffer bytes** for auto
FP32/fused attention and **166,910,992 bytes** for half/fused attention. Half retains
the FP32 weights plus its packed half copy. These figures exclude caller assets,
driver overhead and C-tokenizer WASM memory. The stable independently owned
preflight tokenizer adds a 16 MiB WASM instance and survives GPU disposal;
CPU-only callers can reuse the CPU encoder inspector. CPU fallback model memory
and caller-retained assets must be included by the application's total budget.

## Artifact identity and reproduction

The [CPU 1.0.1 distribution](cpu-distribution.json) freezes scalar **43,431 bytes**
(`4a9a7e01712db5868864104a259aaaeb73af74bb8830d9f54700af67b506dd74`)
and SIMD **43,361 bytes**
(`aa6b6265d68d0e145c56804f8ae4950827f48ef40b2f3b8ce4a87fce1ca1050e`).
It adds owned C strict token inspection and SHA-256 exports. Model format v1,
compiled model identity, scalar/SIMD arithmetic and historical 1.0.0 artifacts
remain unchanged. Diagnostic parity manifests record their different binary
identities; production APIs are separately exercised in Node and browsers.
WebGPU WGSL/runtime distribution remains 1.0.0 and retains the plan 19 identity.

From the repository root:

```sh
python3 packages/quixi-embed/native/scheduler_ci.py --gpu
python3 packages/quixi-embed/native/scheduler_ci.py --skip-provision --full
```

The first command is the recorded full provisioning/browser run; omit `--gpu`
for CPU-only CI. Full 159-case recertification was run through the same native
and WASM generators/comparator exposed by the second command, with independent
routes executed concurrently. See [the service contract](../../../src/scheduler/README.md)
for limits, cancellation/storage semantics and platform prerequisites.

`checksums.json` covers retained raw reports and logs. Wider GPU families,
Windows/Linux desktop WebViews, app RPC and durable private-cache publication,
and a tokenizer source-offset stream remain separate integration/release gates.
