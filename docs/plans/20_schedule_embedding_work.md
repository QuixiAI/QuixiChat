# 20 — Schedule bounded embedding work

**Status:** Implemented — bounded service validated with actual scalar/SIMD browser workers and Apple WebGPU FP32/half/device-loss recovery. App RPC and durable indexing publication landed in plan 21 (`@quixi/quixi-embed/service`, [ADR 0034](../decisions/0034-semantic-indexing-and-hybrid-search.md)).

**Workstream:** C5 — interactive inference service

**Depends on:** [17](./17_build_scalar_encoder_and_model_compiler.md)

## Outcome

Coordinate interactive embeddings and background indexing with bounded queues, dynamic batching, duplicate singleflight, and observable progress.

## Product references

- [63. Static memory planning](../product.md#63-static-memory-planning)
- [68. Inference scheduling](../product.md#68-inference-scheduling)
- [69. Batching](../product.md#69-batching)
- [70. Duplicate singleflight](../product.md#70-duplicate-singleflight)
- [71. Embedding versioning](../product.md#71-embedding-versioning)
- [72. Semantic indexing UX](../product.md#72-semantic-indexing-ux)
- [73. Semantic indexing controls](../product.md#73-semantic-indexing-controls)
- [74. Resume behavior](../product.md#74-resume-behavior)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria)

## Tasks

- [x] Implement the priority classes from the spec: interactive query, current document, new content, recent imports, and archive backfill.
- [x] Implement a bounded scheduler that selects the next work at dispatch boundaries. Do not claim interruption of an already-running GPU/CPU dispatch.
- [x] Use batch 1 for interactive queries and measured token/request/memory budgets for background batches. Consume backend guidance from plans 18–19 as it becomes available.
- [x] Implement duplicate singleflight and bounded result caching keyed by model/artifact identity, embedding role, preprocessing identity, and exact input bytes.
- [x] Define cancellation/joiner behavior, queue saturation/backpressure, shutdown, and backend-error handling so one cancelled consumer does not invalidate work still needed by another.
- [x] Expose progress/statistics, backend/route information, measured throughput, and approximate ETA. Keep persisted completion state and indexing checkpoints in storage, outside the inference engine.
- [x] Add pause/resume and drain behavior for background work while preserving interactive queries. Invalidate cached results when their semantic identity changes.
- [x] Test scheduling deterministically with a controllable executor, then run integration checks with each implemented backend.

## Deliverables and interfaces

- Independent worker/service scheduling API with bounded batches, cache, singleflight, cancellation, and statistics.
- Scheduler fairness/priority tests and documented resource budgets.

## Acceptance criteria

- [x] An interactive request runs at the next eligible dispatch boundary ahead of queued background work.
- [x] Queue and cache sizes remain bounded under large backfills and duplicate-heavy requests.
- [x] Identical concurrent requests infer once; different roles or model identities never share incompatible results.
- [x] Pause/resume and consumer cancellation preserve completed work and release abandoned resources.

## Boundaries and sequencing

Scheduler mechanics can be developed with the scalar executor while production backends progress. Integration in plan 21 requires the SIMD fallback. Durable resume and indexing state are storage responsibilities, not a second persistence subsystem inside QuixiEmbed.

## Implementation and evidence

The package root and `@quixi/quixi-embed/worker` export the independent
[service, types and executor adapters](../../packages/quixi-embed/src/scheduler/README.md).
Importing the entry starts no worker or database. Private cache storage is
injected; storage owns cache persistence, vector/checkpoint publication and late
producer-generation rejection. Statistics explicitly identify inference-only
completions and the scope of the ETA.

Default bounds are 256 unique jobs, 1,024 consumers / 64 per job, 64 KiB input /
8 MiB admitted accounting, 2,048 hot vectors / 16 MiB cache, eight actually
unresolved store calls / 1 MiB, and 50 ms cache observation. Timed-out calls keep
their permits until they actually settle. Queries and CPU dispatches contain one
request; GPU backgrounds default to four requests / 2,048 padded tokens. Priority
selection and CPU task yielding happen after a complete graph. An already active
CPU or GPU dispatch is not interrupted.

CPU artifact 1.0.1 adds owned C strict preflight and exact UTF-8 SHA-256. Input
count saturates at 513, includes role prefix/framing, and rejects overflow before
admission. Cache identity includes frozen model/artifact/tokenizer/preprocessing/
chunking identity, query prefix, role and input digest. Historical 1.0.0 artifacts,
model format v1 and numerical semantics remain preserved. Full source offsets
are still a separate model-aware chunker interface.

[Retained reports and reproduction](../../packages/quixi-embed/tests/reports/scheduler-2026-09-08/README.md)
record:

- 18 deterministic tests, including 5,120 unique backfill jobs and a 5,000-consumer
  rejected duplicate flood with bounded peaks and zero final admitted resources.
- 397 independent upstream untruncated-token fixtures through standalone/model
  scalar/SIMD inspectors; legacy truncated token IDs remain exact.
- All 159 frozen cases through each native/scalar-WASM/SIMD route. Maximum absolute
  upstream error remains 8.5830688e-6; scalar/SIMD outputs are bit-identical.
- 12 actual browser scenarios: scalar/SIMD in Chromium, Firefox and WebKit;
  FP32, half and in-flight GPU-device-loss-to-SIMD in Chromium and WebKit.
  Each checks priority, duplicate cancellation, strict bounds and frozen vectors.
- A complete provisioned `native/scheduler_ci.py --gpu` run passing 22 wrapper
  commands, including the existing pinned CPU build/memory/browser provisioner.

The measured host is Apple M5 Max / macOS 26.6.2. GPU adapters identify actual
Apple hardware; wider GPU families and Windows/Linux desktop WebView coverage
remain release work. Short timing observations include concurrent reference and
development load. Full 512-token CPU dispatches still delay queries until the
current graph finishes, while the renderer's worker-independent heartbeat remains
active. These tests establish service behavior, not durable app indexing completion.

[Back to the roadmap](./README.md)
