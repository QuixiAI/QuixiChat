# Traceability: product success criteria → evidence

Plan [24](../plans/24_validate_scale_and_release_hosts.md) task 1. Each row
names the plans that deliver a criterion, the automated scenarios that
exercise it (with their retained reports), the manual or native host checks,
the benchmark reports where measurement is the evidence, and what is known
not to be covered. "Both engines" means Playwright Chromium and WebKit on
macOS 26.6.2 unless a row says otherwise; native means the Tauri desktop
WebView on the same machine. Dated 2026-09-12; update when evidence changes.

## Product §115: V1 success criteria

| # | Criterion | Plans | Automated scenarios | Host / manual checks | Known limitations |
| --- | --- | --- | --- | --- | --- |
| 1 | Open Quixi Desktop or `quixi.ai` | 01, 05, 24 | Web startup outcomes: `tests/e2e/startup-*.spec.ts` ([storage-proof.md](storage-proof.md)); shared-app proof, 101 checks per engine ([shared-app.md](shared-app.md)) | Native macOS: Tauri storage proof, native host and regional proofs, cross-host restore ([tests/hosts/README.md](../../tests/hosts/README.md), [cross-host-restore.md](cross-host-restore.md)) | Self-hosted web: the built Docker image's isolation headers on every asset, WASM media types, SPA fallback, callback policy and cross-origin isolation in both engines ([web-hosting.md](web-hosting.md)); desktop bundle: identity, disk-image checksum, artifact hashes and the ad-hoc signature state ([desktop-bundle.md](desktop-bundle.md)); the release page publishes hosts, limits and the checklist ([release.md](../release.md)). Still open: `quixi.ai` hosting itself, a Developer ID signature and notarization, an updater, installation on a clean machine; Windows and Linux desktop unverified ([tests/hosts/linux](../../tests/hosts/linux/README.md)) |
| 2 | Initialize SQLite WASM over OPFS | 01, 03 | Storage proof: 8 checks per engine plus Docker-served bundle ([storage-proof.md](storage-proof.md)); every application proof opens the production worker | Tauri storage proof, 22 + 23 checks with process restart ([tauri-macos-26.5.2.json](../../tests/hosts/results/tauri-macos-26.5.2.json)) | Safari automation is disabled on this machine ([safari.md](../../tests/hosts/safari.md)); Linux WebKitGTK 2.50.6 is a measured no-go for synchronous OPFS handles |
| 3 | Remain entirely local | 03, 05, 23 | Credential-boundary scan of records, requests, exports and storage in the shared-app proof; diagnostics export allow-list ([diagnostics.md](diagnostics.md)); no Cloud plan is in scope | Native host keeps secrets in the OS keychain ([native-oauth.md](native-oauth.md)) | Plans 25/26 (Cloud) deferred; not a limitation of local operation |
| 4 | Connect multiple providers | 05, 06, 10 | Provider settings and health, 25 transport checks per engine, model discovery, OAuth browser groups ([provider-capability-review.md](provider-capability-review.md), [browser-oauth.md](browser-oauth.md), [background-health.md](background-health.md)) | macOS installed OAuth callbacks ([native-oauth.md](native-oauth.md)); native provider proofs ([tauri-providers-macos-26.6.2.json](../../tests/hosts/results/tauri-providers-macos-26.6.2.json)) | Live provider behaviour is qualified against controlled HTTP fixtures only; no real provider request is made by any proof (user gate) |
| 5 | Send and stream messages | 06, 08 | Shared-app proof: streaming, stop, regenerate, edit branches, attachments, continuous text across checkpoints; pending-recovery proof, 60 groups per engine ([pending-recovery.md](pending-recovery.md)); reasoning continuation ([reasoning-continuation.md](reasoning-continuation.md)) | Native regional attempts ([native-regional-attempts.md](native-regional-attempts.md)) | Fixture providers stream synthetic responses; checkpoint batching at scale is plan 06's remaining item |
| 6 | Import existing provider history | 04, 11 | Importer acceptance on synthetic ChatGPT/Claude/ZIP fixtures; imports panel proof, 18 checks per engine; extension import receiver ([extension-import.md](extension-import.md)) | — | Official current ChatGPT and Claude export captures are not in the repository (user must supply); the real chatgpt.com extension run is a user gate |
| 7 | Search imported history with FTS5 | 07 | Shared-app search scenarios; search scale at 101k chunks ([search-scale.md](search-scale.md)); incremental verification ([incremental-search-verification.md](incremental-search-verification.md)); portability filter ([bulk-portability.md](bulk-portability.md#portability-search-filter)) | — | Release-corpus relevance study not done (plan 07 open item); rank fixtures are regressions, not a user study |
| 8 | Open an old conversation | 08 | Library paging at 2,001 conversations and a 2,000-message thread ([library-refresh.md](library-refresh.md), shared-app scale scenario) | — | — |
| 9 | Continue it with another provider | 10 | Reviewed provider switch, imported ChatGPT conversation continued with the Anthropic connection, fallback, routing profiles ([provider-capability-review.md](provider-capability-review.md), [routing-aliases.md](routing-aliases.md)) | Native constrained attempts ([native-regional-attempts.md](native-regional-attempts.md)) | Summary fidelity of context compaction has no scored real-model run (plan 10 open item) |
| 10 | Inspect compatibility transformations | 10, 12 | Switch inspection report and review, portability status with per-target reasons, bulk analysis and reviewed migration, compare and critique ([bulk-portability.md](bulk-portability.md), [compare.md](compare.md)) | — | — |
| 11 | Import and search PDF text | 14 | Document extraction and search proofs; extraction browser, layout and performance suites ([plan 14](../plans/14_extract_and_search_documents.md)) | macOS extraction proof (native) | OCR (plan 15) deferred; 1 to 1,000+ pages, malformed, encrypted, multi-column, scanned and image-heavy cases with memory, speed, time to FTS, cancellation and resume are mapped in [pdf-scale.md](pdf-scale.md); WebKit heap and native memory unobserved |
| 12 | Optionally enable local semantic search | 21 | Semantic proof, 14 checks per engine: enrol, index, pause/resume, restart, delete, rebuild ([semantic-search.md](semantic-search.md)); onboarding step 5 ([onboarding.md](onboarding.md)) | — | — |
| 13 | Run QuixiEmbed through WebGPU when available | 19, 21 | WebKit route in the semantic proof; device-loss fallback observed; inference self-test on the live route ([semantic-search.md](semantic-search.md), [diagnostics.md](diagnostics.md)) | Apple M5 Max through Chromium/Metal and WebKit ([plan 19](../plans/19_build_webgpu_backend.md)) | Other GPU families and a hardware-adapter Chromium run remain open (plans 19, 21) |
| 14 | Run QuixiEmbed through WASM SIMD otherwise | 18, 21 | Chromium headless serves the SIMD route in every semantic proof; self-test parity ([diagnostics.md](diagnostics.md)) | — | — |
| 15 | Hybrid-search chats and document text | 21 | Best fuses lexical and semantic rankings by RRF (semantic proof); document semantic search ([plan 14](../plans/14_extract_and_search_documents.md)) | — | — |
| 16 | Pause/resume semantic backfill | 20, 21 | Pause keeps vectors searchable and refuses claims; Resume indexes only new content (semantic proof) | — | — |
| 17 | Export a complete local archive | 09 | Portable and open exports at 30,000 messages in bounded steps, open export read with system `tar` and `JSON.parse` ([archive-scale.md](archive-scale.md)); archive client proofs ([archive-client.md](archive-client.md)); a 1,000,000-message portable export (3,980 MB) produced in bounded steps and streamed to disk with its digest verified ([storage-stress.md](storage-stress.md)) | — | The 1M export takes hours in WebKit (about 2.6–2.8 h before the clean-copy batching); the restore of that export is being recorded |
| 18 | Restore that archive elsewhere | 09 | Isolated restore validation, corrupted container refused; web export restored in the native WebView with equal records and blob hashes ([cross-host-restore.md](cross-host-restore.md)) | Native macOS WebView | The native candidate is validated and read back, not activated; desktop → web direction not separately run |
| 19 | All without Quixi persistently storing their history | 03, 05 | Same as criterion 3 | — | — |

## Product §116: product-core criteria with semantic indexing disabled

The imports, archives, providers and storage-health proofs mount the
application without an embedding runtime; the shared-app proof provisions the
model but runs its import, chat, search, switch and export scenarios before
any enrolment; the semantic proof's `embedding=missing` scenario checks that
an unprovisioned model is an explicit asset failure with lexical search intact.

| Requirement | Evidence without semantic indexing |
| --- | --- |
| import | imports panel proof (18 checks per engine, no embedding runtime); extension receiver proof |
| chat | shared-app proof scenarios before enrolment; pending-recovery proof |
| FTS search | shared-app search scenarios; search scale proof runs with `embedding=missing` ([search-scale.md](search-scale.md)) |
| switch providers | reviewed switch and routing scenarios in the shared-app proof before enrolment |
| export | archives proofs and the archive scale proof, both with `embedding=missing` ([archive-scale.md](archive-scale.md)) |

Plan 24's acceptance "disabling or breaking semantic inference leaves every
product-core criterion passing" is additionally covered by the semantic
namespace fault fixture (exact search stays OK while the semantic index is
rebuildable, [diagnostics.md](diagnostics.md)).

## Product §117: QuixiEmbed criteria

| Criterion | Plans | Evidence | Known limitations |
| --- | --- | --- | --- |
| Tokenizer matches reference | 16, 17 | Frozen goldens (159 cases) and offset fixtures; inference self-test reproduces frozen ids in both engines ([diagnostics.md](diagnostics.md)) | — |
| Scalar implementation matches reference | 17 | `wasm-parity-report.json` (cosine ≥ 0.999999, max abs 8.6e-6 over 159 cases); self-test max 1.1e-7 on three cases | — |
| WASM SIMD passes numerical thresholds | 18 | SIMD parity, kernel checks and browser distribution gates (plan 18 complete) | Timing evidence limited to development load on the exercised host |
| WebGPU passes numerical thresholds | 19 | GPU CI report on Apple M5 Max (Chromium/Metal, WebKit); self-test live-route max 8.9e-8 | Other GPU families open |
| Retrieval benchmark passes | 16, 21 | Production chunker on the plan 16 corpus: Recall@5 0.8426, Recall@10 0.8981, MRR 0.8611 ([plan 21](../plans/21_integrate_semantic_and_hybrid_search.md)) | Corpus is the plan 16 reference corpus, not a user study |
| Memory is bounded | 18, 20 | Plan 18 measured peak/steady live bytes with zero leaked allocations; scheduler limits and bounded service ([plan 20](../plans/20_schedule_embedding_work.md)) | — |
| Intermediate GPU tensors stay resident | 19 | Persistent weight buffers and static scratch with GPU-resident intermediates (plan 19 task) | — |
| No generic inference runtime is needed | 16–19 | The runtime is the model-specialized WASM/WGSL port; no ONNX or generic engine is bundled | — |
| Interactive queries preempt background indexing | 20, 21 | Priority classes and preemption in the scheduler; queries embed while backfill runs (semantic proof) | — |
| Compressed retrieval works at large-index scale | 22 | 100k/500k/1M benchmark and the 101k-vector coarse stage in both engines ([search-scale.md](search-scale.md), [ADR 0036](../decisions/0036-compressed-vector-retrieval.md)) | — |
| Indexing exposes realistic speed/ETA | 20, 21 | Chunks per second and estimated remaining time from measured throughput (semantic panel, semantic proof) | ETA scope is admitted documents, stated in the panel |
| All retained optimizations have benchmark evidence | 18, 19, 22 | Plan 18 SIMD performance, plan 19 GPU benchmarks, ADR 0036 decisions with measured reports | — |
