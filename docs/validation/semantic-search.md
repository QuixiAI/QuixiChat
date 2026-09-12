# Semantic indexing and hybrid search qualification

Date: 2026-09-11. Plan: [21](../plans/21_integrate_semantic_and_hybrid_search.md).
Decision: [ADR 0034](../decisions/0034-semantic-indexing-and-hybrid-search.md).
Retained record: [semantic-search-checks-macos.json](results/semantic-search-checks-macos.json)
(30 source hashes including the pinned tokenizer, both WASM modules, the lock
and the provisioned model; `sourceStable: true`).

Environment: macOS 26.6.2 (Darwin 25.6.0, arm64, Apple M5 Max), Node
v22.23.1, Playwright Chromium and WebKit, the pinned SQLite 3.53.4 +
sqlite-vec v0.1.9 build, CPU runtime 1.0.2, WebGPU kernels 1.0.0, model
`arctic-xs.qxmodel` SHA-256 `e1ef345c…efffc` served by the Vite preview from
`packages/quixi-embed/build/`. Timings are single observations on a shared
development host under concurrent load; they establish behavior, not
throughput.

## Commands

```sh
npm run test:search                   # 27 lexical + 10 semantic storage + 5 indexer + 1 query tests
npm run test:app:semantic:browser     # shared application, Chromium + WebKit, real model
npm run test:app:browser              # full application proof with the semantic scenario appended
```

## Repository checks (`npm run test:search`)

`packages/search/tests/semantic.test.ts` drives `SearchRepository` on the
pinned SQLite WASM with the real tokenizer artifact and deterministic synthetic
unit vectors (a topic direction plus a digest-derived perturbation):

| Case | What it establishes |
| --- | --- |
| typed lock mirrors lock.json | `MODEL_LOCK` equals `artifacts/model/lock.json` |
| model-aware chunking | every chunk of a 120-sentence message and its context-prefixed input fits the 256-token budget; the index version names the tokenizer; a tokenizer-less fixture keeps `:none:none` |
| enrolment/claims/RRF | enrolment starts generation 2 with 4 pending chunks; a 2-chunk claim leases; a second claim returns the other two; publication indexes all four; Semantic ranks the topic neighbours first; Best puts the dual-origin hit first with "Exact + semantic match" and keeps lexical highlights; Exact ignores the vector; thread filters apply to both rankings; fused pages continue by cursor and refuse a foreign cursor; a zero vector is refused; same-identity re-enrolment keeps vectors, a different identity drops them |
| per-item rejection | `stale_generation`, `chunk_changed`, `invalid_vector`, `duplicate` (within and across publications); deletion moves the generation so later publications are stale |
| pause/resume/restart/leases | paused claims return nothing while vectors stay searchable; a fresh repository over the same database claims only the two unfinished chunks; leased chunks are not re-offered until the 5-minute lease expires; the byte bound admits one input at a time |
| rebuild and edits | a lexical epoch rebuild keeps every link (same chunk identity); a title edit changes identity, the two chunks become pending with the new context and bounded maintenance removes the orphaned vectors |
| deletion and damage | deleting drops vectors, keeps `quixi_records`/`quixi_sync_ops` counts and lexical hits, and is idempotent by operation id; a dropped semantic table leaves lexical status `ready` with an explicit unusable reason, enrolment is refused by name, and delete repairs the namespace |
| sign-bit projection (ADR 0036 amendment 2, 2026-09-12) | default threshold 100,000 keeps exact retrieval for small indexes (the browser proof shows "3 / 3 sign-bit (0.0 MB) · exact retrieval below 100,000 vectors"); with `semanticCoarseThreshold: 3`, five published vectors are projected at once, the coarse→rerank ranking equals the exact ranking of a second repository on the float path, the resident index is 0 bytes before the first coarse query and 48 bytes per vector after it, a vector published while resident is appended and found; sign bits follow sqlite-vec's layout and `hammingTopK` keeps the lower id on ties; a simulated version-1 namespace with legacy float chunks and a version-2 int8 projection upgrades in place (vectors kept, `chunk_size=16` rebuilt, int8 dropped, ledger 1,3) and maintenance backfills; a foreign representation is discarded at open and rebuilt with coarse retrieval working again; semantic deletion empties the projection while the lexical hit remains. |
| batched slices (ADR 0038 fix 6, 2026-09-12) | one write transaction per indexing slice with savepoints inside, closed around blob awaits; current sources are not re-enqueued; 10k messages in Chromium 211 s → 58 s (search, extraction, extraction-search, navigation and archive suites pass) |
| head visibility flag (ADR 0038 fix 5, 2026-09-12) | `repository.test.ts`: a legacy-shaped namespace (legacy triggers, no `stale` column, legacy checksum) with a title changed under the legacy triggers upgrades in place at open — heads kept, the changed head flagged and invisible, this build's triggers installed, re-index restores it, and a new title change flags immediately; 44 search-package tests |
| indexing throughput (ADR 0038, 2026-09-12) | queue pick by index seeks, obsolete gate, one progress report per slice, message-driven thread expansion; derived ledger version 2 upgrades in place (`quixi_search_schema` rows 1,2); 30,000-message browser proof in [search-scale.md](search-scale.md) |
| candidate join order (2026-09-12) | the 658-chunk hybrid benchmark (`perf/retrieval/hybrid.mjs`) exercises the semantic and coarse candidate queries end to end; a 2,000-vector Node probe measured 1,028 ms per page before the KNN was materialized and 28 ms after (ADR 0036, ADR 0037) |
| lexical matching (ADR 0037) | `query.test.ts`: every term quoted, FTS operators literal, AND join by default and OR under `match: "any"`; the repository test keeps "OR needle" a literal two-term query in Best and Exact |
| document pages | two registered PDF pages with identical text and one message are claimed together, share one stored vector (3 indexed chunks, 2 vectors) and are found by page with `sourceTypes` filters |

`packages/search/tests/indexer.test.ts` runs the loop against fake storage and
embedding clients: 40 chunks in 16-chunk claims until nothing is pending;
stale publications counted and the loop ending explicitly after repeated
stale cycles with no vector entering the index; pause stopping claims and
background inference with resume indexing only the remaining chunks and each
chunk embedded once; stop cancelling a slow dispatch in under 400 ms without
publishing; a closed runtime failing the loop without further storage calls.

Result: 41 tests pass (`# pass 41`), with the existing 27 lexical, chunker and
fusion cases unchanged except the semantic dependency-gate wording.

## Shared application (`npm run test:app:semantic:browser`)

Ten checks per engine in a fresh archive with the production storage worker
(which now loads the pinned tokenizer for chunking) and the real model:

| Check | Chromium | WebKit |
| --- | --- | --- |
| Best before enrolment is lexical-only with the storage reason | pass | pass |
| Enrol: model verified, backend selected, 3/3 chunks indexed with progress/backend/speed/size | WASM SIMD · CPU ("No WebGPU adapter" in headless) | WebGPU · FP32 |
| Semantic: "why does my cat make a rumbling noise" ranks *Feline care* first, "Semantic match" | pass | pass |
| Best: "migration check" leads with "Exact + semantic match", other hits "Semantic match" | pass | pass |
| Exact stays lexical | pass | pass |
| Pause keeps vectors searchable and refuses claims; Resume indexes only the added chunk (3/4 → 4/4) | pass | pass |
| Restart: enrolment/generation/vectors persist, model loads from the OPFS copy, queries work without re-indexing | pass | pass |
| Disable unloads the runtime, index and enrolment survive | pass | pass |
| Delete removes vectors and enrolment, keeps messages and lexical search | pass | pass |
| Unprovisioned model: explicit asset refusal, Best falls back to text with a visible reason | pass | pass |

Observed timings (ms): enable-to-backend 850 / 857, enable-to-indexed 925 /
861, restart-to-backend 814 / 810 (Chromium / WebKit). The Chromium enable
includes the loopback download of the 90.8 MB model and its SHA-256; WebKit's
shows the model already present in OPFS for the origin (its persistent
profiles share origin storage), which is why the missing-model case disables
the OPFS copy explicitly.

## Full application proof (`npm run test:app:browser`)

The complete runner passes **76 checks per engine** (the existing 66 groups
plus this scenario) against the production storage worker with tokenizer-aware
chunking and the semantic namespace present; retained as
[semantic-search-app-macos.json](results/semantic-search-app-macos.json) with
its source hashes stable. The keyboard path from the search field to the first
result is unchanged because the mode selector precedes the field. The
[documents persistence proof](../../packages/documents/tests/persistence-browser/README.md)
and the storage client, extraction-search, search-navigation, document UI and
conversation-search-navigation browser suites pass on the same build; the
persistence proof's stale schema-10 assertion was corrected to schema 12.

## Findings during qualification

- The embedding worker's token preflight closure bound a local that was
  cleared after initialization, so every background dispatch failed with
  "Strict token preflight failed" while queries still worked. Fixed by binding
  the tokenizer instance; the panel surfaced the failure as an indexing problem
  rather than hiding it.
- WebKit (Playwright build, macOS 26.6.2) crashes its page process with
  `EXC_BAD_ACCESS` in `WebCore::GPUDevice::contextDestroyed` when a dedicated
  worker that ever held a WebGPU device is destroyed while the page lives
  (`worker.terminate()` and `self.close()` alike; crash reports
  `com.apple.WebKit.WebContent.Development-2026-09-11-2330*.ips`). The service
  now parks a worker on shutdown (model memory released, re-initialisable) and
  the application keeps one worker per page. A page reload in Safari with a
  GPU-touched worker remains exposed to that WebKit bug; plan 24's Safari
  qualification must observe it on a real Safari build.
- Vite's preview answers unknown asset paths with the SPA page (HTTP 200); the
  worker refuses it by digest. Digest refusal and HTTP 404 are both reported.

## Limits and open gates

- Filtering is applied after a bounded vec0 candidate set (256, or 1024 with
  filters); plan 22 owns large-index candidate generation and compressed
  retrieval. No large-archive semantic scale, disk or latency measurement was
  taken here.
- Production chunk policy is the 256-token structural policy; retrieval
  quality with this exact chunker on the plan 16 corpus is not yet measured
  (the baseline used the reference 256/32 window chunker).
- Chromium headless exposed no WebGPU adapter; the GPU route in the
  application is qualified on WebKit here and by plan 19/20 worker proofs.
  Device-loss fallback inside the application is not exercised.
- Onboarding step 5 wiring belongs to plan 13's onboarding flow; the Semantic
  search panel provides the Enable/Later choice and every §73 control.
- Docker images carry no model; provisioning is documented in
  `deploy/docker/README.md`. Desktop (Tauri) serving of `dist/models` is not
  exercised natively in this iteration.
