# ADR 0034 — Semantic indexing and hybrid search integration

Date: 2026-09-11. Status: accepted for plan 21's first vertical slice; the
evidence section records what is qualified and what remains.

## Problem

Plans 07, 14, 16–18 and 20 delivered lexical search, document extraction, the
frozen Arctic XS port, WASM SIMD/WebGPU encoders and a bounded scheduler that
runs without any product package. Nothing connected them: no vectors were
stored, `SearchRepository.search` refused `semantic`, `fuseRanked` had no
caller, and no host loaded the model. Product §42–§53 and §71–§75 require
Exact, Semantic and Best modes over shared chunks, RRF with k=60, versioned
embeddings that never mix silently, resumable bounded indexing with the five
explicit controls, and lexical usability whenever inference is disabled,
incomplete, rebuilding or failing.

## Decisions

### Chunk policy becomes model-token aware everywhere

Production chunking uses `StructuralChunker` with the existing 4096/64 UTF-16
lexical bounds **and** the frozen Arctic tokenizer (`tokenizeWithOffsets`,
runtime 1.0.2) with a **256 source-token** budget. This is the reference
policy the plan 16 retrieval baseline measured (256-token windows); §50's
benchmark-driven range is 250–400 tokens. The chunker version, and therefore
the derived index version, now includes the tokenizer identity
(`arctic-xs-offsets-1.0.2:<tokenizer sha prefix>`) and budget, so an upgraded
archive rebuilds its lexical epoch automatically while the previous epoch
stays searchable (ADR 0007). Alternatives rejected:

- Keeping 4096-unit lexical chunks and truncating each to 512 tokens for
  embedding contradicts §48 ("never represented only by a truncated first 512
  tokens").
- Sub-windowing inside the claim would make the embedding unit differ from the
  SearchChunk, contradicting §47's single abstraction.

The Storage Worker therefore loads the 44 KB scalar WASM and the 514 KB
`.qxtokenizer` artifact (both bundled, SHA-256 pinned in
`packages/quixi-embed/artifacts/model/lock.json`) at open. No model weights
and no inference are involved. If those assets fail to load, derived search
initialization reports a typed failure and canonical writes continue, exactly
like a broken derived schema; the worker never falls back to the lexical-only
policy, which would flip-flop index versions between sessions. Fixtures that
construct `SearchRepository` without a tokenizer keep the explicit
`:none:none` version.

### Vectors live in a separate derived namespace on sqlite-vec

`quixi_semantic_*` has its own schema ledger, distinct from `quixi_search_*`,
so lexical repair never drops vectors and a broken semantic namespace never
disables lexical search. Layout:

| Object | Purpose |
| --- | --- |
| `quixi_semantic_meta` | state (`disabled`/`enrolled`/`paused`), enrolled `EmbeddingModelIdentity`, generation, revision |
| `quixi_semantic_vectors` | one row per distinct embedding input digest and generation |
| `quixi_semantic_vec` (`vec0(embedding float[384])`) | the float32 payload, rowid = vectors.id |
| `quixi_semantic_links` | chunk → digest, vector, lease timestamp, explicit failure |
| `quixi_semantic_operations` | idempotent enrol/delete operation identities |

The embedding input is the §48 format `context prefix` + blank line + chunk
text; `textDigest` is the SHA-256 of that exact UTF-8 input. Vectors are keyed
by that digest, so identical chunks (duplicate passages, chunks recreated by a
lexical rebuild) share one vector and are relinked without inference. A
context or source edit changes the chunk identity and digest, so the old
vector is orphaned and removed by bounded maintenance rather than reused.
Portable/open/rescue archives export canonical records and sync operations
only; the namespace is never exported (`derived_search`, `inference_models`).

### Generations and per-item rejection

Enrolment with a different identity, deletion and rebuild each start a new
generation and drop every vector and link. `publishSemanticVectors` checks
every item independently: `stale_generation`, `model_mismatch`,
`chunk_changed` (missing link or digest mismatch), `duplicate`, and
`invalid_vector` (wrong length, non-finite, or not approximately unit). Nothing
partial or stale enters the index. Claims lease chunks for five minutes so a
lost worker's chunks return without duplicate work in the common case; late
publications for a re-claimed chunk are accepted only when the digest still
matches, which is the same vector.

Inputs whose context-prefixed form overflows the model are retried with the
text alone; an input that still overflows is recorded as `oversized` and
excluded from pending counts instead of being truncated. With the 256-token
policy this is a defensive path, not an expected one.

### Query path and fusion

`searchArchive` keeps the existing FTS pages for Exact and for Best without a
vector (`best_lexical`, with the storage reason in `index.semantic`). With a
query vector and an enrolled model, Best fuses the top 256 BM25 hits with a
bounded vec0 KNN candidate set (256, or 1024 when filters are present) through
`fuseRanked` (RRF, k=60); Semantic ranks the candidate set alone. Filters are
applied to both rankings identically after candidate generation; deterministic
fused pages use an offset cursor bound to query, filters, vector digest, epoch,
index revision and semantic revision. Lexical hits keep their FTS highlights;
semantic-only hits carry a bounded plain excerpt. Explanations follow §46.

Post-KNN filtering over a bounded candidate set is a documented limitation:
heavily filtered queries over very large indexes can miss matching vectors
beyond the candidate bound. Plan 22's compressed coarse retrieval and
partitioned candidate generation own the large-index answer.

### Runtime ownership and delivery

`@quixi/quixi-embed/service` adds a dedicated worker (`worker.ts`) and client
(`createEmbeddingService`) around the plan 20 scheduler. The caller supplies
every asset URL with its pinned SHA-256; the worker refuses bytes whose digest
or size differs. The 90.8 MB model is a separately provisioned host asset
served under `/models/arctic-xs.qxmodel` (Vite dev/preview middleware and a
`dist/models` copy when present; Docker images without it report the model as
unavailable). The worker caches the verified model in OPFS under
`quixi-embed/models/<sha256>.qxmodel`, outside every archive namespace, and
re-verifies it on every load. Backend order: WebGPU when the host exposes a
hardware adapter and shaders are supplied, otherwise WASM SIMD, otherwise
scalar; GPU loss falls back to CPU through the scheduler.

The application owns the service lifetime through a semantic feature
controller: enrolment loads the runtime and starts the `@quixi/search`
indexer (claim → embed at archive priority → publish, four in flight, 16-chunk
claims), Pause keeps the runtime and vectors, Disable keeps the index but
unloads the runtime, Delete drops the index, Rebuild deletes and re-enrols.
Queries embed at interactive priority and fall back to lexical Best with a
visible reason when the runtime is unavailable.

### Worker lifetime on WebKit

Qualification found that WebKit (Playwright build on macOS 26.6.2) crashes
its page process in `WebCore::GPUDevice::contextDestroyed` when a dedicated
worker that ever held a WebGPU device is destroyed while the page lives,
whether by `worker.terminate()` or `self.close()`. The service therefore
parks a worker on shutdown: the scheduler, encoder and tokenizer are
disposed (model memory released) and the same worker initializes again on
the next Enable. The application keeps one worker per page and lets the
document's teardown end it. A page reload in Safari with a GPU-touched worker
remains exposed to the WebKit defect; plan 24 must observe it on real Safari.

## Evidence

- `npm run test:search`: 27 lexical/chunker/fusion tests plus 9 semantic
  storage tests on the real tokenizer and synthetic unit vectors (bounded
  claims and leases, per-item rejection, pause/resume/restart resuming only
  missing chunks, rebuild relinking, deletion preserving canonical records and
  lexical search, a broken namespace isolated from lexical search, document
  pages sharing one vector) and 5 indexer loop tests (bounded cycles, stale
  rejection, pause/resume, cancellation, fatal runtime): 41 pass.
- `npm run test:app:semantic:browser`: ten checks per engine in Chromium
  (WASM SIMD; headless exposes no adapter) and Playwright WebKit (WebGPU FP32)
  with the pinned model, retained in
  [semantic-search-checks-macos.json](../validation/results/semantic-search-checks-macos.json);
  [semantic-search.md](../validation/semantic-search.md) records timings,
  findings and the remaining gates (large-index candidate generation,
  production-chunker relevance measurement, in-app GPU loss fallback,
  onboarding wiring, native desktop serving of the model).
