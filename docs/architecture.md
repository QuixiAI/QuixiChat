# Repository architecture

## Status and authority

[product.md](product.md) is the implementation baseline, moved verbatim from
`refactor.md`. This document maps that specification onto code ownership.
Package directories and empty entry modules reserve boundaries; they do not
indicate completed product functionality.

## Hosts and application

`apps/web` and `apps/desktop` mount `@quixi/app`. They are composition roots:
they supply host adapters and the same production storage client. The document
persistence workflow and document UI have browser integration evidence; mounting
the embedding service remains later integration work. The shared application owns UI,
query snapshots and workflow controllers; the composition root owns service
lifetime and awaits application teardown before closing clients. Host-specific code must stay out of its feature components.

The Tauri crate belongs to the desktop host. It provides secrets, provider HTTP
and file dialogs. OAuth callbacks, notifications and remaining native privileges
retain their explicit capability gates.
It does not own a canonical history database. The new shell does not start the
prototype's loopback inference server or install Gemma.

Docker serves the web build. It does not introduce server-side user history.
The extension (`apps/extension`, Chromium MV3) extracts provider-native records
in the user's signed-in tab and transfers one export-compatible bundle to the
paired Quixi page through the web host's `extensionBridge`
([ADR 0035](decisions/0035-browser-extension-import.md)); normalization and
canonical writes belong to the importer and Storage Worker.

## Package boundaries

| Package | Owns | Depends on through contracts |
| --- | --- | --- |
| `core` | Canonical entities, branching rules, host/worker/import contracts | No UI, database, native host, or inference implementation |
| `app` | UI and application workflows | Core and the public feature/client APIs it composes |
| `storage` | SQLite, migrations, transactions, FTS/vector SQL, blobs, archives, sync operations | Core contracts |
| `providers` | Live request/response protocols and capability descriptions | Core; injected host transport and secret access |
| `importers` | Validation, normalization, source identity, deduplication planning, provenance | Core; injected storage client for commits |
| `search` | Shared chunking, query coordination, RRF, the semantic indexing loop | Core; injected storage and embedding clients |
| `documents` | PDF.js integration, extraction, structural normalization | Core and shared chunking; bounded downstream sinks |
| `quixi-embed` | Tokenizer, model graph, kernels, scheduling, model packaging, the dedicated embedding worker/service | No Quixi product or persistence packages |

Dependencies listed here describe intended boundaries. Add manifest dependencies
when used. Storage imports only the tokenizer/chunking entry of `quixi-embed`
(no weights, no inference) so production chunk identity is model-token aware;
the application imports its service entry to own the embedding worker's
lifetime ([ADR 0034](decisions/0034-semantic-indexing-and-hybrid-search.md)). Import workspace packages through their explicit package exports, not
relative paths into another package. Keep worker clients separate from worker
implementations. Export additional modules deliberately instead of adding a
wildcard export.

`core/model` contains the canonical model; `core/contracts` contains the APIs and
serializable messages crossing process or application boundaries. Avoid a general
utilities bucket. The model is defined in TypeScript first; introduce generated
Rust bindings only for contracts actually used by native commands.

## Storage ownership

Only `storage/worker` may open SQLite. UI and workflow code use `storage/client`.
Database repositories, migrations, and the pinned SQLite build remain private
implementation details. Use one build containing FTS5 and sqlite-vec on all hosts.

Typed local preferences also belong to the Storage Worker, in archive-scoped
device metadata. They do not create canonical/sync records or travel in portable
exports. [ADR 0018](./decisions/0018-local-preferences-and-routing-presets.md)
defines the boundary and implemented reusable routing aliases. Applying an alias
copies the reviewed primary/fallback/requirements snapshot into canonical state
with its sync operation; later local alias edits do not change that conversation.

The worker owns atomic canonical mutations plus sync operations, import commits,
and multi-tab database ownership. Search SQL lives here, while shared chunking and
rank fusion live in `search`. Search requests and normalized import records cross
the client boundary; SQL handles do not.

## Optional inference

`quixi-embed` must build and run its correctness and performance harnesses without
the product UI. Its JavaScript entry point will control a dedicated worker;
numeric execution belongs to model-specific WASM and WebGPU code. CPU language
selection remains part of the port work.

Model weights and generated binaries are build/download artifacts. Pin the model,
compiler inputs, checksums, and tokenizer goldens in the source tree. Keep the
model compiler and WGSL kernels with this package.

The application must be usable without loading the embedding runtime or weights.
Basic text extraction, chunking, import, chat, and FTS cannot await inference.
Keep any tokenization needed by chunking separately usable from model execution.
Persistent vectors, embedding progress, and derived-index metadata belong to
storage; the inference runtime has no conversation database dependency. The
compiled model is a separately provisioned host asset served under `/models/`
and verified against the pinned lock by the embedding worker before use.

## Build and validation

The root npm workspace covers `apps/*` and `packages/*`. Vite builds the web and
desktop entry points, both consuming shared TypeScript source. React and bounded
external query stores are selected for the product UI in
[ADR 0009](./decisions/0009-shared-interface-and-state.md); the shared application now mounts chat, imports, provider setup, search and
archive and document workflows; remaining feature and accessibility gates are tracked by plan.

The root Cargo workspace currently contains only the Tauri host. Future native
embedding code belongs under `packages/quixi-embed/native`, using its own build
system as appropriate. It must not be coupled to a desktop-only dependency.

Keep unit tests beside their packages. Root `tests/` is for cross-package and
host integration. Root `perf/` owns product workload measurements; embedding
kernel benchmarks live with QuixiEmbed. The legacy workspace is checked
separately and is never a dependency of the new product.

## First implementation slices

1. A1: initialize the same SQLite WASM/OPFS build through both host entry points;
   exercise migrations, FTS5, sqlite-vec, ownership, durability, and failure cases.
2. Add canonical entities and transactional storage using a real export fixture.
3. Build the first importer against those contracts and measure bounded memory.
4. Add live providers and conversation UI while QuixiEmbed develops independently.

The measured Linux WebKitGTK 2.50.6 build fails the required OPFS synchronous
access-handle gate; it is not qualified. Other Linux builds and Windows still
need qualification. Browser persistence guarantees and release conditions are
recorded in the [storage matrix](./validation/storage-proof.md).
The presence of a buildable shell does not satisfy the universal-storage gate.

## Reviewed request context

[ADR 0019](decisions/0019-reviewed-context-compaction.md) binds attachment
exclusions to immutable ContextSnapshots, with a ContextCompaction event and
canonical journal entries in the same transaction. The shared workflow replaces
selected occurrences before loading attachment bytes; it preserves all source
records. Schema 11 gates older writers and archive protocol 3 isolates older
followers on the shared owner-lock boundary. Summaries and explicit compaction
branches remain future work. [Validation](validation/context-compaction.md)
records the bounded review, browser and portable restore evidence.
