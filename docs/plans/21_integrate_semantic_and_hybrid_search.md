# 21 — Integrate semantic indexing and hybrid search

**Status:** In progress — enrolment, versioned vector storage on sqlite-vec, bounded resumable indexing, Exact/Semantic/Best with RRF, the §72/§73 controls and the local runtime service are implemented and qualified in Chromium and WebKit ([ADR 0034](../decisions/0034-semantic-indexing-and-hybrid-search.md), [validation](../validation/semantic-search.md)); onboarding-flow wiring, in-app GPU fallback observation and production-chunker relevance measurement remain open.

**Workstream:** C6/D3 — optional product integration

**Depends on:** [07](./07_build_shared_chunks_and_fts.md), [14](./14_extract_and_search_documents.md), [18](./18_optimize_wasm_simd.md), [20](./20_schedule_embedding_work.md)

## Outcome

Connect local embedding workers to shared chat/document chunks and provide Exact, Semantic, and Best search without compromising lexical availability.

## Product references

- [42. Unified search architecture](../product.md#42-unified-search-architecture)
- [43. Reciprocal Rank Fusion](../product.md#43-reciprocal-rank-fusion)
- [44. Search modes](../product.md#44-search-modes)
- [45. Search filters](../product.md#45-search-filters)
- [46. Search result UX](../product.md#46-search-result-ux)
- [47. SearchChunk](../product.md#47-searchchunk)
- [48. Message chunking](../product.md#48-message-chunking)
- [49. Document chunking](../product.md#49-document-chunking)
- [50. Chunking strategy](../product.md#50-chunking-strategy)
- [53. Query/document distinction](../product.md#53-querydocument-distinction)
- [71. Embedding versioning](../product.md#71-embedding-versioning)
- [72. Semantic indexing UX](../product.md#72-semantic-indexing-ux)
- [73. Semantic indexing controls](../product.md#73-semantic-indexing-controls)
- [74. Resume behavior](../product.md#74-resume-behavior)
- [75. sqlite-vec integration](../product.md#75-sqlite-vec-integration)
- [94. Onboarding](../product.md#94-onboarding)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [106. Track D — Documents](../product.md#106-track-d--documents)
- [109. Semantic-search build](../product.md#109-semantic-search-build)
- [116. Product-core success criteria](../product.md#116-product-core-success-criteria)

## Tasks

- [x] Implement explicit semantic enrollment, model download/hash verification, backend detection, worker initialization, and fallback selection. Load model/runtime resources only when needed. — `@quixi/quixi-embed/service` fetches every asset by URL with a pinned SHA-256 and size, caches the verified model in OPFS, selects WebGPU (hardware adapters only) → WASM SIMD → scalar, and initializes nothing until the Semantic search panel's Enable or a query needs it. Chromium chose WASM SIMD (no headless adapter), WebKit WebGPU FP32; an unprovisioned model is an explicit asset refusal ([validation](../validation/semantic-search.md)).
- [x] Persist EmbeddingModel identity and per-chunk embedding status/version in storage. Include model, tokenizer, preprocessing, chunking, and representation compatibility in invalidation rules. — `quixi_semantic_meta` stores the full `EmbeddingModelIdentity`; links carry digest, vector, lease and failure per chunk; a different identity (any of the eight fields, `chunkingVersion` being the storage index version) starts a new generation and drops every vector (semantic storage tests).
- [x] Implement bounded indexing of new and historical chunks, pause/resume, missing/outdated-only restart, deletion, and rebuild operations. Reject stale results if the source or model changed during inference. — 1–64-chunk / ≤1 MiB claims with five-minute leases, newest chunks first; pause refuses claims; restart and resume claim only unfinished chunks; delete and rebuild move the generation; publications are rejected per item for stale generations, changed chunks, duplicates and malformed vectors (storage and indexer tests; browser pause/resume/restart/delete checks).
- [x] Embed queries with query semantics and chunks with document semantics. Store/retrieve vectors only through StorageClient and the pinned sqlite-vec build. — the application embeds queries at interactive priority with the query role and chunks at archive priority with the document role; vectors enter only through `publishSemanticVectors` into the `vec0` table of the pinned build, and leave only through `deleteSemanticIndex` or maintenance.
- [x] Implement RRF over ranked lexical and semantic results with initial k=60, consistent filtering, stable source identity, and duplicate-result handling. Do not compare raw BM25 and cosine scores directly. — `fuseRanked` over the top 256 BM25 hits and a bounded vec0 candidate set; identical filters on both rankings; chunk rowid identity; deterministic fused pages with offset cursors. Post-candidate filtering over a bounded set is the recorded limitation for plan 22.
- [x] Implement search modes, match explanations, coverage/backend status, indexing progress, realistic speed/ETA, and recoverable model/backend failures. — Best/Exact/Semantic selector; "Exact text match" / "Semantic match" / "Exact + semantic match"; the panel shows indexed/total, backend, measured chunks/sec, approximate ETA from recent throughput, index size and state; asset and runtime failures are shown and Resume retries the runtime.
- [ ] Feed extracted PDF and optional OCR text through the same pipeline as messages. Extend onboarding/settings and document progress without delaying initial FTS availability. — Extracted pages flow through the same claim pipeline (document-page storage test: two identical pages share one vector and resolve by page); settings expose the §72/§73 panel; lexical indexing never waits on enrolment. Open: the onboarding step 5 prompt inside plan 13's onboarding flow. OCR is deferred (plan 15).
- [ ] Integrate WebGPU from plan 19 when ready and validate automatic WASM fallback. Keep a modest float-vector baseline for correctness before compressed scale work. — WebGPU is attempted first and used in WebKit; the CPU route serves Chromium headless; float32 is the only representation. Open: an in-application device-loss fallback observation (the scheduler-level fallback is plan 20 evidence) and a hardware-adapter Chromium run.

## Deliverables and interfaces

- Semantic indexing lifecycle, StorageClient vector operations, and complete hybrid-search UI/workflows.
- Versioned invalidation/resume behavior and cross-source retrieval integration tests.

## Acceptance criteria

- [x] Chat, import, export, and FTS continue working when semantics are disabled, incomplete, rebuilding, or failing. — lexical search is proven usable before enrolment, while paused, after deletion, with an unprovisioned model and with a damaged semantic namespace; the full application proof (chat, imports, exports, FTS) runs with the semantic namespace present and disabled ([validation](../validation/semantic-search.md), [shared app](../validation/shared-app.md)).
- [x] Old/incompatible embeddings and stale asynchronous results never enter the active index silently. — generation checks, digest checks and vector validation reject per item; the indexer counts rejections and stops after repeated stale cycles with an explicit reason.
- [x] Pause/restart resumes only missing or outdated chunks; deleting semantic data preserves canonical history. — storage restart/lease tests and the browser pause/resume/restart/delete checks; record and sync-operation counts are unchanged by deletion.
- [x] RRF results explain their lexical/semantic origin and match deterministic fixtures with consistent filters. — fusion unit tests, the hybrid storage fixture (dual-origin hit first, filters on both rankings, cursor continuation) and the browser Best check.

## Boundaries and sequencing

Large-index readiness depends on plan 22, and the accelerated semantic release requires plan 19. Neither blocks the core-product milestone. A lexical-only Best mode remains available when semantic results cannot be produced.

## Implementation and evidence

- Chunking: production storage workers load the pinned tokenizer (44 KB WASM + 514 KB artifact, hashes in `packages/quixi-embed/artifacts/model/lock.json`) and chunk with a 256-token budget; the derived index version names the tokenizer, so upgraded archives rebuild their lexical epoch while the previous epoch stays searchable. Fixtures without a tokenizer keep the explicit lexical-only version.
- Storage: `packages/storage/src/worker/search/semantic.ts` (namespace, claims, publication, KNN candidates, maintenance) and the hybrid/semantic paths in `search/index.ts`; six operations dispatched by `archive-database.ts`.
- Loop and runtime: `packages/search/src/semantic/indexer.ts`; `packages/quixi-embed/src/service/`.
- Application: `packages/app/src/features/semantic/` (controller, panel, bundled asset pins), the search-mode selector and result labels in `AppRoot.tsx`; hosts pass `/models/arctic-xs.qxmodel`, served by `tooling/embedding-assets.ts`.
- Evidence: `npm run test:search` (41 tests), `npm run test:app:semantic:browser` (10 checks per engine, retained in [semantic-search-checks-macos.json](../validation/results/semantic-search-checks-macos.json)), and the full application proof with the scenario appended (76 groups per engine, [retained](../validation/results/semantic-search-app-macos.json)).
- Known WebKit defect: destroying a worker that held a WebGPU device crashes the page process; the service parks workers instead (ADR 0034, validation findings). Plan 24's Safari qualification must re-observe this on a real Safari build.

[Back to the roadmap](./README.md)
