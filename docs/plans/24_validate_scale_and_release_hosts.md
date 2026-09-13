# 24 — Validate scale and release supported hosts

**Status:** Planned

**Workstream:** Release gates — core, migration, and semantic milestones

**Depends on:** [01](./01_prove_universal_storage.md)

## Outcome

Produce evidence-backed release candidates for supported web/desktop hosts, with separate completion gates for the usable core, compelling migration product, and semantic-search build.

## Product references

- [6. Deployment architecture](../product.md#6-deployment-architecture)
- [94. Onboarding](../product.md#94-onboarding)
- [103. Track A — Product Core](../product.md#103-track-a--product-core)
- [104. Track B — Historical Import](../product.md#104-track-b--historical-import)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [106. Track D — Documents](../product.md#106-track-d--documents)
- [107. First usable build](../product.md#107-first-usable-build)
- [108. First compelling migration build](../product.md#108-first-compelling-migration-build)
- [109. Semantic-search build](../product.md#109-semantic-search-build)
- [110. Release/platform risks](../product.md#110-releaseplatform-risks)
- [111. Storage stress tests](../product.md#111-storage-stress-tests)
- [112. Semantic-search stress tests](../product.md#112-semantic-search-stress-tests)
- [113. QuixiEmbed benchmarks](../product.md#113-quixiembed-benchmarks)
- [114. PDF stress tests](../product.md#114-pdf-stress-tests)
- [115. V1 success criteria](../product.md#115-v1-success-criteria)
- [116. Product-core success criteria](../product.md#116-product-core-success-criteria)
- [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria)
- [118. Explicit v1 non-goals](../product.md#118-explicit-v1-non-goals)

## Tasks

- [x] Create a traceability checklist mapping product success criteria to completed plans, automated scenarios, manual host checks, benchmark reports, and known limitations. [traceability.md](../validation/traceability.md) maps every §115, §116 and §117 criterion to its plans, retained scenarios, host checks, benchmark reports and known limitations (dated 2026-09-12).
- [ ] Run the first-usable gate once plans 01–03 and 05–09 are complete: local storage, two providers, chat/history, FTS, and portable export. Do not wait for embedding optimization.
- [ ] Run the compelling-migration gate after plans 04, 10, and 11: import existing history, import incrementally, inspect compatibility, and continue with another provider.
- [ ] Complete the local v1 feature gate with plans 12–14 and 23, including compare/critique, onboarding/themes/accessibility, documents, and recovery. OCR remains optional.
- [ ] Run storage/import stress workloads at 100k threads, 1M+ messages, and 10–50 GB attachments. Measure startup, migration, quota failure, concurrent tabs, interrupted writes, export, and restore without archive-wide materialization. — The stress harness ([storage-stress.md](../validation/storage-stress.md)) seeds through the production worker and measures integrity, library paging, cold reopen, a concurrent tab, a portable export streamed to disk in bounded steps and a restore validation streamed back; the smoke run passes in both engines and the 100k-conversation / 1M-message WebKit run is recorded there. Its first attempt found and fixed a real scale defect: the whole-file `integrity_check` outlived the client's 60 s reply deadline, and the same scan ran at startup; the explicit report now carries a 600 s deadline and the startup read is bounded by file size (ADR 0040 amendment 3). Its second attempt found the library view costing 25 s per page at 100k conversations; schema 13 materializes per-thread activity (ADR 0043). Its third attempt passed paging (9 ms first page) and found the export snapshot copying 4.7 GB in one step; the snapshot is now stepped by `maxBytes` (ADR 0010 amendment). Attachments at 10–50 GB exceed this machine's browser quota; quota failure, interrupted writes and migration stay at the storage proof's small scale.
- [x] Run PDF cases from 1 to 1000+ pages, including malformed, encrypted, multi-column, scanned, and image-heavy inputs; report memory, extraction speed, time to FTS, cancellation, and resume. — [pdf-scale.md](../validation/pdf-scale.md) maps every case to plan 14's retained browser evidence and the production performance harness: 1/100/1,000 pages measured end to end in both engines, 1,001 pages refused by the declared 1,000-page limit, malformed/encrypted/scanned as typed outcomes, multi-column through the layout proof, the 31 MB image-heavy PDF, Chromium per-isolate forced-GC memory, first-page FTS times, cancellation and resume. WebKit heap and native memory remain unobserved; OCR is deferred.
- [ ] Gate a semantic-enabled release on plans 16–22, including WebGPU and WASM routes, retrieval quality, 100k/500k/1M-vector behavior, indexing preemption, and optional-semantics failure scenarios.
- [ ] Validate web hosting and Docker headers/origin behavior, desktop installation and native integrations, release artifact integrity, signing/update configuration, and upgrade persistence. Keep unsupported WebViews explicitly provisional. — Web hosting/Docker is done ([web-hosting.md](../validation/web-hosting.md), 2026-09-13): the built image's isolation headers on every asset, WASM media types, SPA fallback versus asset 404s, the callback route's policy and log exclusion, and cross-origin isolation plus the storage backend in both engines; it found and fixed a missing-model 200 fallback and onboarding's unverified "model provided" claim. Release artifact integrity and signing/update state are recorded ([desktop-bundle.md](../validation/desktop-bundle.md), 2026-09-13): the produced app and disk image are hashed, the image checksum verifies, the bundle is now ad-hoc signed and sealed (it was only linker-signed, failing deep verification), no Developer ID exists on this machine and no updater is configured. Desktop installation on a clean machine, native integrations of the release bundle and upgrade persistence remain.
- [ ] Publish host support, measured limits, known issues, migration/rollback instructions, and release checklists. Keep optional Cloud and explicit v1 non-goals out of local release blockers.

## Deliverables and interfaces

- Milestone-specific release checklists, cross-host end-to-end results, stress reports, and supported-platform matrix.
- Reproducible release packaging/update configuration and documented recovery/rollback paths.

## Acceptance criteria

- [ ] Every claimed milestone has evidence for its required functionality, with no placeholder success indicators.
- [ ] Disabling or breaking semantic inference leaves every product-core success criterion passing.
- [ ] Platform support is based on actual OPFS/storage behavior, including Safari and Linux/WebKitGTK results where claimed.
- [ ] A release archive can be exported, restored, and upgraded on the supported host matrix; unknown limits are disclosed rather than implied as tested.

## Boundaries and sequencing

The listed dependency establishes the platform-validation foundation. Feature and recovery prerequisites are conditional on the milestone being validated, as listed in the tasks and roadmap README. Quixi Doctor is required for the complete local product gate, not the first usable build. This plan is revisited at each release gate instead of forcing all tracks into one serial launch.

[Back to the roadmap](./README.md)
