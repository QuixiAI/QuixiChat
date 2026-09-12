# Quixi Chat — Product & Technical Design Spec

**Version:** v1.0 implementation baseline
**Status:** ready to build
**Date:** September 2026

---

# 1. Product

Quixi is a permanent, provider-neutral home for a user's AI conversation history.

A user can:

* connect multiple AI providers;
* import years of existing conversation history;
* keep that history locally;
* continue old conversations using different models;
* compare and critique models;
* migrate away from providers;
* search across every conversation and text-bearing attachment;
* import and search PDFs and documents;
* export everything in open formats;
* optionally enable encrypted multi-device synchronization and backup.

Quixi is not primarily an API aggregator.

Its core promise is:

> **Your AI history belongs to you, not to the company that generated it.**

A user should be able to stop using:

* OpenAI;
* Anthropic;
* Google;
* another AI provider;
* or Quixi itself

without losing ownership of their history.

---

# 2. Product positioning

Quixi should lead with:

> **Your AI history, independent of the company that generated it.**

Supporting message:

> Import the conversations you already have.
> Keep them locally.
> Search everything you've discussed with AI.
> Continue old conversations with new models.
> See exactly what changes when you switch.
> Export everything whenever you want.

Documents support the history product.

Quixi is not positioned in v1 as a general-purpose "second brain" or document-management system.

PDF and document support exists because files are frequently part of AI conversations and users need to retrieve what they discussed.

---

# 3. Product pillars

## 3.1 Own your history

Conversation history is stored locally by default.

Quixi Cloud is optional.

The local archive remains usable without:

* a Quixi account;
* Quixi Cloud;
* the original provider;
* an active provider subscription;
* internet access except when calling remote models.

---

## 3.2 Bring your existing history

Import is mandatory.

A user with years of ChatGPT, Claude, Gemini, or other conversations should be able to bring that history into Quixi immediately.

Import mechanisms include:

* Quixi browser extension;
* official provider exports;
* provider APIs where appropriate;
* Quixi archives;
* future third-party formats.

Import is a primary onboarding experience.

---

## 3.3 Continue anywhere

A sufficiently portable conversation can continue with another provider or model.

Quixi explains any lossy transformation before switching.

Examples:

* tool calls flattened to text;
* unsupported attachments omitted;
* provider reasoning metadata removed;
* citations transformed;
* provider-specific artifacts degraded;
* context compacted.

---

## 3.4 Search years of history

Search has two independent layers.

### Baseline lexical search

```text id="3h0tuj"
FTS5
```

This is part of the product core.

It is always available once text has been imported or created.

### Optional semantic search

```text id="kcszfo"
QuixiEmbed
    ↓
snowflake-arctic-embed-xs
    ↓
sqlite-vec
```

Semantic indexing is derived and optional.

Quixi must remain fully functional if semantic indexing:

* is disabled;
* is incomplete;
* is rebuilding;
* is unavailable on the current hardware;
* fails.

---

## 3.5 Own performance-critical execution

Quixi does not depend on generic inference frameworks for local semantic indexing.

No:

* ONNX Runtime;
* Transformers.js;
* generic graph executor;
* browser PyTorch runtime.

Quixi owns:

* tokenizer;
* fixed model graph;
* model packaging;
* memory planning;
* CPU kernels;
* WebGPU kernels;
* batching;
* scheduling;
* caching;
* quantization;
* numerical validation;
* retrieval-quality validation;
* benchmarking.

The engineering philosophy is:

> **Prefer fixed graphs, known shapes, and model-specialized kernels over generic abstractions.**

---

# 4. V1 semantic scope: text only

Quixi v1 does not generate embeddings for images.

Semantic indexing applies to text extracted from:

* user messages;
* assistant messages;
* code;
* Markdown;
* PDFs;
* OCR;
* document text;
* attachment metadata.

Images remain first-class attachments but are not vectorized.

They may still be found through:

* surrounding conversation text;
* filenames;
* provider captions;
* alt text;
* OCR text;
* attachment descriptions.

There is no:

* image encoder;
* CLIP model;
* image vector index;
* text-to-image retrieval;
* image-to-image retrieval

in v1.

This keeps semantic search aligned with the dominant Quixi workload:

> **text-to-text retrieval across AI history.**

---

# 5. Hard architectural rules

## Rule 1

> **All user-facing Quixi hosts use the same Storage Worker → SQLite WASM → OPFS backend.**

This includes:

* Quixi Desktop;
* `quixi.ai`;
* Docker/self-hosted web.

---

## Rule 2

There is no secondary canonical history backend.

No:

* IndexedDB conversation database;
* native desktop SQLite conversation database;
* default server-side Docker history database.

---

## Rule 3

> **The host changes; the database does not.**

Every host runs the same:

* SQLite WASM build;
* schema;
* migrations;
* FTS5;
* `sqlite-vec`;
* storage repositories;
* import transaction code;
* synchronization-operation model.

---

## Rule 4

Only the Storage Worker owns SQLite.

The UI does not directly open or mutate the database.

---

## Rule 5

Canonical content is authoritative.

The following are derived and rebuildable:

* FTS indexes;
* semantic embeddings;
* compressed vector indexes;
* search caches;
* ranking caches;
* generated summaries.

---

## Rule 6

> **Semantic indexing must never be a dependency of chat, import, or lexical search.**

---

## Rule 7

> **Quixi owns its semantic inference runtime down to model-specific WASM SIMD and WGSL kernels.**

---

## Rule 8

Cloud is optional.

Local operation is complete without Quixi Cloud.

---

# 6. Deployment architecture

## 6.1 Quixi Desktop

Tauri provides a privileged shell around the universal Quixi frontend.

```text id="4z1thf"
Tauri
  │
  ▼
WebView
  │
  ├── Quixi UI
  ├── Storage Worker
  ├── PDF Worker
  └── Embedding Worker
```

Persistence:

```text id="5d10g5"
Storage Worker
      ↓
SQLite WASM
      ↓
OPFS
```

Tauri provides:

* OS keychain;
* direct provider HTTP;
* OAuth callbacks;
* file dialogs;
* archive import/export;
* browser-extension pairing;
* notifications;
* deep links;
* signed updater.

Tauri does not own conversation persistence.

---

## 6.2 quixi.ai

```text id="tcrv37"
Browser
  │
  ├── Quixi UI
  ├── Storage Worker
  ├── PDF Worker
  └── Embedding Worker
```

Persistence:

```text id="0fs11x"
SQLite WASM
    ↓
OPFS
```

Quixi infrastructure may provide:

* application hosting;
* authentication;
* provider relay;
* optional encrypted Cloud synchronization.

It does not automatically persist the user's local archive.

---

## 6.3 Docker / self-hosted web

Default mode:

```text id="c15w4r"
Docker
   ↓
serves frontend
   ↓
Browser
   ↓
same Quixi runtime
   ↓
SQLite WASM / OPFS
```

The container is stateless with respect to ordinary user history.

Each browser profile owns its own local archive.

---

# 7. Runtime architecture

```text id="m7beqx"
                           Quixi UI
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
 Storage Worker           PDF Worker         Embedding Worker
        │                     │                     │
  SQLite WASM              PDF.js               QuixiEmbed
        │                     │                     │
   ┌────┴─────┐               │             ┌───────┴────────┐
   │          │               │             │                │
 FTS5    sqlite-vec           │         WebGPU backend   WASM backend
   │          ▲               │             │                │
   │          │               │        Quixi WGSL       C/Rust SIMD
   │          │               │             │                │
   │          └──── vectors ──┴─────────────┴────────────────┘
   │
  OPFS
```

---

# 8. Host architecture

Persistent state and privileged host functionality are separate.

Conceptually:

```typescript id="59jqyq"
interface CoreClient {
    storage: StorageClient;
    host: HostClient;
}
```

`StorageClient` owns:

* conversations;
* imports;
* search;
* documents;
* embeddings;
* routing metadata;
* synchronization metadata.

`HostClient` owns:

* provider HTTP;
* secrets;
* OAuth;
* native files;
* notifications;
* platform integrations.

---

# 9. Universal SQLite distribution

Quixi maintains a pinned SQLite WASM distribution.

Conceptually:

```text id="xxfrj5"
quixi-sqlite.wasm
    │
    ├── SQLite
    ├── FTS5
    └── sqlite-vec
```

Every Quixi host runs the same build.

The binary is:

* version-pinned;
* checksummed;
* tested cross-platform;
* upgraded deliberately.

---

# 10. Storage Worker

The Storage Worker is the sole database owner.

Responsibilities:

* SQLite initialization;
* migrations;
* serialized writes;
* transactions;
* conversation repositories;
* import commits;
* FTS;
* vector storage;
* attachment metadata;
* synchronization operations;
* archive export;
* archive restoration;
* storage diagnostics.

Conceptual API:

```typescript id="ns6g59"
interface StorageClient {
    threads: ThreadRepository;
    messages: MessageRepository;
    generations: GenerationRepository;

    imports: ImportRepository;

    documents: DocumentRepository;

    search: SearchRepository;
    embeddings: EmbeddingRepository;

    attachments: AttachmentRepository;

    routing: RoutingRepository;
    sync: SyncRepository;

    archives: ArchiveRepository;
}
```

---

# 11. OPFS layout

Conceptually:

```text id="7byixc"
OPFS/
  quixi/
    database/
      <SQLite VFS files>

    blobs/
      00/
      01/
      ...
      ff/

    models/
      ...

    temp/
```

Application-managed blobs and models remain separate from directories reserved by the SQLite VFS.

---

# 12. Multi-tab ownership

Only one context owns the active SQLite connection.

```text id="vackvt"
Tab A ─┐
Tab B ─┼── coordination
Tab C ─┘
           │
           ▼
      storage owner
           │
        Web Lock
           │
           ▼
    Storage Worker
           │
         SQLite
```

Other tabs receive updates through:

* BroadcastChannel;
* equivalent same-origin messaging.

Events may include:

```text id="1n6o17"
threadCreated
threadUpdated
messageAdded
generationCompleted
importProgress
embeddingProgress
storageChanged
```

---

# 13. Storage UX

Example:

```text id="69hswv"
Storage

Location
This browser

Database
SQLite WASM / OPFS

History
6.9 GB

Attachments
3.1 GB

Semantic index
482 MB

Persistent storage
✓ Enabled

Quixi Cloud
Off

[Export Backup]
[Enable Cloud Backup]
```

Quixi explicitly explains that browser/WebView local storage belongs to the current device/profile/origin.

---

# 14. Persistence status

Quixi distinguishes clearly between:

```text id="pbld0q"
Persistent storage
✓ Granted
```

and:

```text id="vg9pvo"
Persistent storage
⚠ Not granted

Your browser may remove local Quixi data
under storage pressure.

[Request Persistent Storage]
[Export Backup]
```

Explicit user clearing of application/site data may remove OPFS content even when persistent storage has been granted.

---

# 15. Storage quota UX

Before a large import:

```text id="wkml19"
Import estimate

Conversation data       820 MB
Attachments             4.7 GB
Estimated semantic index
                        310 MB

Estimated total         5.8 GB

Available local storage
43 GB

[Continue]
```

Semantic-index size is shown separately from canonical history.

---

# 16. Canonical conversation model

## Thread

```text id="gs6p6m"
Thread {
    id
    workspace_id
    created_at

    system_prompt?
    import_source?
    preferred_route?
}
```

Mutable state:

```text id="cg343s"
ThreadState {
    title
    tags
    pinned
    archived
    active_leaf
    routing_profile
}
```

---

# 17. Message

```text id="9rq5og"
Message {
    id
    thread_id
    parent_id?

    role
    created_at

    parts[]
}
```

Messages do not inherently belong to one provider.

---

# 18. Generation

A Generation represents one model attempt.

```text id="e89qei"
Generation {
    id
    parent_message_id

    provider
    provider_account
    model

    parameters
    status

    created_at
    completed_at?

    tokens_in?
    tokens_out?
    cached_tokens?

    estimated_cost?
    reported_cost?

    parts[]

    raw_provider_response?
    compatibility_metadata?
}
```

Statuses:

```text id="21uzrf"
streaming
complete
stopped
failed
cancelled
partial
```

---

# 19. Content parts

```text id="f8kv7v"
ContentPart =
    Text
  | Image
  | File
  | Audio
  | Citation
  | ToolCall
  | ToolResult
  | ReasoningMetadata
  | StructuredData
  | ProviderArtifact
  | Note
```

---

# 20. Branching

History is a tree.

Editing creates a branch.

Regeneration creates another candidate Generation.

The UI shows one active path while retaining siblings.

---

# 21. Raw provider preservation

Provider-native data should be retained whenever practical.

This enables:

* future re-normalization;
* importer improvements;
* compatibility analysis;
* debugging;
* historical fidelity.

---

# 22. Thread events

Explicit events include:

```text id="ysvjbm"
ProviderSwitch
AutomaticFallback
ContextCompaction
ImportWarning
Migration
UserNote
```

Example:

```text id="clmqds"
Switched models

Claude → GPT

2 tool calls converted to text.
Reasoning metadata was not transferred.
```

---

# 23. Historical import

Import is part of the product core.

Supported sources may include:

* ChatGPT;
* Claude;
* Gemini;
* other providers;
* provider exports;
* Quixi archives.

---

# 24. Browser extension architecture

The extension extracts provider-native data.

```text id="yl3bef"
Provider page
    │
    ▼
Quixi Extension
    │
    ▼
ProviderImportBundle
    │
    ▼
Quixi Importer
    │
    ├── validate
    ├── normalize
    ├── reconstruct branches
    ├── deduplicate
    ├── preserve raw source
    ├── identify attachments
    └── generate warnings
            │
            ▼
      Storage Worker
            │
          SQLite
```

The extension does not:

* directly modify SQL;
* run migrations;
* define Quixi's canonical schema;
* decide normalization policy.

---

# 25. Incremental import

After the initial import:

> **Import new conversations**

should process only new or changed source material.

Identity priority:

1. provider-native IDs;
2. stable provider metadata;
3. deterministic fingerprints.

Titles are never identifiers.

---

# 26. Import provenance

```text id="sz7g6x"
ImportSource {
    provider
    method

    source_thread_id?
    source_url?

    importer_name
    importer_version

    source_format_version?
    source_fingerprint?

    imported_at
}
```

---

# 27. Import transactions

A logical thread should generally import atomically.

```text id="59zu64"
BEGIN

thread
messages
generations
attachment metadata
import provenance
sync operations

COMMIT
```

Large archives stream through many bounded transactions.

---

# 28. Import UX

Example:

```text id="r16wp0"
ChatGPT Import

Threads discovered           18,422
Imported                     18,301
Imported with warnings          115
Failed                             6

Messages                    481,204
Attachments                   7,831

Transformations
• 54 unavailable images referenced
• 21 legacy tool records preserved raw
• 8 unsupported artifacts converted
• 3 malformed records skipped

[Review Warnings]
[Retry Failed]
[Export Report]
```

Significant transformation is never silent.

---

# 29. Core chat experience

V1 includes:

* streaming;
* stop generation;
* Markdown;
* LaTeX;
* syntax-highlighted code;
* code copy;
* images;
* files;
* attachment previews;
* drag and drop;
* edit;
* regenerate;
* branches;
* branch navigation;
* quote/reply;
* model badges;
* token counts;
* cost estimates;
* thread system prompts;
* advanced generation settings;
* keyboard shortcuts;
* rename;
* pin;
* archive;
* tags;
* global search;
* model switching;
* routing state.

---

# 30. Provider adapters

Conceptual provider interface:

```text id="gj5b3h"
authenticate()
listModels()
describeModel()
capabilities()

stream()

countTokens()
estimateCost()

normalizeResponse()
```

Provider-specific behavior remains isolated.

---

# 31. Typed capabilities

```text id="lh98ye"
ModelCapabilities {
    input_modalities
    output_modalities

    context_window
    max_output_tokens

    files {...}
    images {...}
    tools {...}
    reasoning {...}
    structured_output {...}

    web_search
    image_generation
    streaming

    system_prompt_mode
}
```

The UI derives controls from capabilities.

---

# 32. Account health

States include:

```text id="o2zhsv"
Healthy
Rate limited
Authentication expired
Provider degraded
Region unavailable
Offline
Unknown
```

Account health feeds:

* visible status;
* fallback logic;
* routing.

---

# 33. Model aliases

Users can define:

```text id="nx0n4w"
Best
Fast
Cheap
Coding
Private
Long Context
Local
```

Aliases resolve to routing profiles.

---

# 34. Routing policies

Example:

```text id="o4nxhr"
Coding

Primary
Provider A / Model X

Fallback
Provider B / Model Y

Requirements
✓ tool support
✓ context >= 100k

Maximum request cost
$0.50
```

Policies may constrain:

* provider;
* model;
* privacy class;
* region;
* tools;
* modalities;
* context;
* cost.

---

# 35. Privacy classes

Possible classes:

```text id="5na638"
Local
Direct provider
Quixi relay
Self-hosted remote
Custom remote
```

Moving across privacy classes may require user confirmation.

---

# 36. Compatibility Inspector

Example:

```text id="bef6bf"
Switch to GPT

Preserved
✓ 42 text messages
✓ 3 images
✓ 6 files

Transforms
⚠ 2 tool calls converted to text
⚠ reasoning metadata unavailable

Context
Current       41,822 tokens
Target limit  32,000 tokens

11,400 older tokens must be compacted.

Estimated request
$0.18

[Cancel]
[Review]
[Switch]
```

---

# 37. Portability status

Threads receive:

```text id="sa5ip1"
Fully portable
Portable with transformations
Provider-dependent
Blocked
```

The reason is inspectable.

---

# 38. Context compaction

Quixi never silently truncates history.

When required:

```text id="9tdojg"
This model cannot fit the current thread.

○ Summarize older messages
○ Exclude selected attachments
○ Start a branch from here
○ Cancel
```

Compaction is recorded as a ThreadEvent.

---

# 39. Compare mode

```text id="o0lvft"
             Prompt
               │
       ┌───────┼───────┐
       ▼       ▼       ▼
    Model A Model B Model C
```

Each answer is a Generation.

Users may:

* compare;
* select one;
* branch from any;
* continue multiple alternatives.

---

# 40. Critique mode

One model may review another Generation.

The critique never overwrites the original answer.

---

# 41. Bulk migration

Example:

```text id="j13ekj"
Move history away from Provider A

Threads                 4,281

Fully portable          3,914
Needs transformation      351
Provider-dependent         16
```

Original history remains preserved.

---

# 42. Unified search architecture

```text id="44lciv"
                    Search Query
                         │
               ┌─────────┴─────────┐
               │                   │
              FTS5             QuixiEmbed
               │                   │
               │              384-D query
               │                   │
               ▼                   ▼
         BM25-ranked           semantic-ranked
          result list           result list
               │                   │
               └─────────┬─────────┘
                         ▼
                Reciprocal Rank Fusion
                         │
                         ▼
                     final list
```

---

# 43. Reciprocal Rank Fusion

V1 hybrid search uses **Reciprocal Rank Fusion (RRF)**.

Raw BM25 and cosine scores are not directly compared.

Conceptually:

```text id="ulqo3w"
RRF(document) =
Σ 1 / (k + rank_in_result_list)
```

Initial:

```text id="41ahk4"
k = 60
```

unless benchmark data strongly justifies another value.

Benefits:

* no score-normalization tuning;
* robust combination of independent retrievers;
* simple implementation;
* deterministic behavior;
* easy debugging.

Future ranking systems may use:

* weighted RRF;
* score calibration;
* learned rerankers

only after the Quixi retrieval benchmark exists.

---

# 44. Search modes

Default:

```text id="vdyb11"
Best
```

uses RRF over lexical and semantic rankings.

Advanced:

```text id="xdk8gu"
Exact
Semantic
Best
```

Users do not need to understand BM25 or vectors.

---

# 45. Search filters

Initial filters:

* source type;
* provider;
* model;
* date;
* tags;
* thread;
* document;
* file type;
* code presence;
* imported/native;
* portability status.

Filtering should happen before or as early as practical in retrieval.

---

# 46. Search result UX

Each result explains why it was returned.

Examples:

```text id="hhuxhr"
Exact text match
```

```text id="bg7uif"
Semantic match
```

```text id="4n0v9a"
Exact + semantic match
```

Result cards may show:

* thread/document title;
* provider;
* date;
* page;
* role;
* highlighted excerpt.

---

# 47. SearchChunk

Chats and documents share one semantic indexing abstraction.

```text id="y5kzrs"
SearchChunk {
    id

    source_type
    source_id

    chunk_index

    text
    context_prefix

    token_start?
    token_end?

    embedding_model_id?
    embedding_status
}
```

Possible `source_type` values:

```text id="86q77w"
message
document
ocr
code
tool_output
```

This prevents document-specific chunking logic from diverging from message chunking.

---

# 48. Message chunking

Long chat messages must be chunked before semantic embedding.

Example:

```text id="fc8d72"
3,000-token assistant answer
        ↓
shared Quixi chunker
        ↓
chunk 1
chunk 2
chunk 3
...
```

Context prefix:

```text id="yojzif"
Thread Title > Assistant

<chunk text>
```

A long message is never represented only by a truncated first 512 tokens.

---

# 49. Document chunking

Document chunks use the same chunking engine.

Context prefix:

```text id="0lmx35"
Document Title > Section > Subsection

<chunk text>
```

Chunking behavior is versioned because it affects embeddings.

---

# 50. Chunking strategy

Benchmark candidate maximum chunk sizes:

```text id="8yjlxs"
128
192
256
320
384
448 tokens
```

Likely production target:

```text id="tp9prm"
~250–400 tokens
```

but benchmark results decide.

Boundary priority:

1. section/heading;
2. paragraph;
3. list;
4. code block;
5. sentence;
6. token-level split.

Small overlap is used only when a logical block must be split.

---

# 51. Semantic model

The initial model is:

> **Snowflake `snowflake-arctic-embed-xs`**

The production port freezes an exact source checkpoint and cryptographic hash.

Expected contract:

```text id="ie818u"
text-only retrieval encoder

384-D output

512-token maximum input

query/document asymmetric retrieval semantics
```

---

# 52. Why Arctic Embed XS

The dominant Quixi retrieval problem is:

```text id="j97w9g"
text query
    ↓
chat text
assistant text
code/explanations
PDF paragraphs
OCR text
```

A small text retrieval model is better aligned with this workload than a CLIP text tower.

It is small enough to:

* ship/download in-browser;
* hand-port;
* run through WASM SIMD;
* optimize through WebGPU;
* backfill large archives.

---

# 53. Query/document distinction

QuixiEmbed exposes:

```text id="y6kt75"
embed_query(text)
embed_document(text)
```

The model's retrieval prefix/prompt behavior and pooling semantics are frozen in the port specification.

Document vectors and query vectors are produced with the appropriate roles.

---

# 54. QuixiEmbed architecture

```text id="wj0s2o"
                         QuixiEmbed
                              │
                      fixed model graph
                              │
                       .qxmodel package
                              │
                    static memory planner
                              │
                     bounded scheduler
                              │
              ┌───────────────┴───────────────┐
              │                               │
        WebGPU backend                  CPU backend
              │                               │
       Quixi WGSL kernels             Quixi C/Rust kernels
              │                               │
           WebGPU                         WASM SIMD
              │                               │
              └───────────────┬───────────────┘
                              │
                     normalized 384-D
                           vector
```

---

# 55. No generic inference runtime

QuixiEmbed does not implement or depend on:

* ONNX graph execution;
* generic operator registries;
* arbitrary model loading;
* dynamic tensor graphs;
* generic shape inference.

The selected model graph is explicit.

---

# 56. Model port specification

QuixiEmbed has its own `PORT_SPEC.md`.

It freezes:

* exact source repository;
* exact revision;
* source file hash;
* tensor inventory;
* tokenizer vocabulary;
* tokenizer behavior;
* special tokens;
* input maximum;
* architecture;
* dimensions;
* layer count;
* attention layout;
* activation behavior;
* normalization epsilon;
* pooling;
* query semantics;
* output normalization.

No optimization work starts before the reference contract exists.

---

# 57. Model packaging

Upstream weights are converted offline.

```text id="emdd2o"
upstream checkpoint
       │
       ▼
quixi-model-compiler
       │
       ├── verify hash
       ├── verify tensor inventory
       ├── transpose/reorder
       ├── pack matrices
       ├── convert precision
       ├── quantize
       └── checksum
       │
       ▼
arctic-xs.qxmodel
```

The browser never parses a training-framework graph at runtime.

---

# 58. Fixed graph

Conceptually:

```text id="c9x27t"
UTF-8 text
    ↓
BERT tokenizer
    ↓
IDs + masks
    ↓
embedding stage
    ↓
fixed transformer stack
    ↓
pooling
    ↓
L2 normalization
    ↓
384-D embedding
```

Exact graph semantics follow the frozen port specification.

---

# 59. Tokenizer

Quixi owns the tokenizer implementation.

It must reproduce:

* normalization;
* WordPiece;
* casing behavior;
* punctuation handling;
* special tokens;
* truncation;
* masks;
* padding behavior.

Tokenizer output is regression-tested against reference fixtures.

---

# 60. CPU backend

```text id="u7bl31"
C or Rust
   ↓
WASM
   ↓
WASM SIMD
```

Maintain a scalar reference implementation.

Then optimize model-specific:

* embedding lookup;
* normalization;
* projections;
* attention;
* FFN;
* activation;
* residuals;
* pooling.

No production numeric JavaScript kernels.

---

# 61. WebGPU backend

```text id="wbhflm"
QuixiEmbed runtime
       ↓
WebGPU scheduling
       ↓
Quixi WGSL kernels
       ↓
GPU
```

WGSL kernels are:

* version-controlled;
* bundled with Quixi;
* benchmarked;
* numerically validated.

---

# 62. GPU residency

Intermediate tensors remain GPU-resident.

```text id="8funvk"
input upload
    ↓
GPU
    ↓
full encoder
    ↓
384-D output
    ↓
single readback
```

No per-layer CPU roundtrip.

---

# 63. Static memory planning

At model initialization allocate:

```text id="eprlt7"
persistent
──────────
weights

scratch
───────
activation A
activation B
QKV
attention workspace
FFN workspace
output
```

Steady-state inference should not allocate new GPU buffers.

The CPU backend follows the same bounded-workspace principle.

---

# 64. Kernel specialization

Implement only the kernels required by the model.

Potential families:

```text id="19ua2t"
embedding gather
LayerNorm
QKV projection
attention
attention output + residual
FFN up + activation
FFN down + residual
pooling
L2 normalization
```

Known shapes are an optimization opportunity.

---

# 65. Kernel fusion

Possible retained fusions:

```text id="wyppp2"
LayerNorm + QKV
QKV + packing
output projection + residual
LayerNorm + FFN up + activation
FFN down + residual
pooling + normalization
```

Every retained fusion must:

* improve benchmarked performance;
* preserve numerical acceptance;
* preserve retrieval quality.

---

# 66. Execution routes

Possible WebGPU routes:

```text id="vsuo0c"
FP32 baseline

FP16 fast route

FP16 + subgroup route
```

Optional WebGPU features improve performance but are not correctness requirements.

WASM SIMD is always the CPU fallback.

---

# 67. Autotuning

Quixi may benchmark a bounded set of kernel variants.

Persist:

```text id="7ekvzu"
GPU/device fingerprint
runtime version
kernel version
selected variants
```

Retune when relevant identities change.

---

# 68. Inference scheduling

Priority:

```text id="2o1rdc"
P0 interactive semantic query
P1 current document
P2 newly created content
P3 recent imported content
P4 archive backfill
```

Interactive queries preempt background indexing after the current dispatch finishes.

---

# 69. Batching

Interactive:

```text id="8laxr5"
batch = 1
```

Background:

```text id="mbgu0x"
batch = N
```

where N is selected from:

* backend;
* device performance;
* memory;
* benchmark results.

---

# 70. Duplicate singleflight

Request identity includes:

```text id="k4wgp0"
model hash
embedding role
input bytes
```

If identical work:

* cached → reuse;
* already in flight → join;
* new → infer.

---

# 71. Embedding versioning

Every embedding references:

```text id="cmgcrg"
EmbeddingModel {
    id

    model_name
    model_version
    source_hash

    dimensions

    tokenizer_version
    preprocessing_version
    chunking_version

    storage_representation
}
```

Incompatible vectors are never mixed silently.

---

# 72. Semantic indexing UX

Example:

```text id="s9e9hf"
Semantic Search

Indexed
318,420 / 1,041,882 chunks

Backend
WASM SIMD · CPU

Current speed
37 chunks/sec

Estimated remaining
~5h 26m

Index size
206 MB

[Pause]
```

On WebGPU:

```text id="nat0yx"
Backend
WebGPU · FP16

Current speed
620 chunks/sec
```

ETA is approximate and based on recent measured throughput.

For large archives, Quixi may recommend WebGPU when available.

---

# 73. Semantic indexing controls

Users may:

```text id="kpsh1x"
Pause
Resume
Disable
Delete Semantic Index
Rebuild Semantic Index
```

Deleting the semantic index never deletes canonical history.

---

# 74. Resume behavior

Completed chunks remain indexed.

On restart:

```text id="vvyw1i"
resume only missing/outdated chunks
```

No full archive restart.

---

# 75. sqlite-vec integration

The pinned Quixi SQLite build includes the exact tested `sqlite-vec` version.

Semantic indexes are derived.

V1 storage may use:

* float32;
* int8;
* bit-vector representations

depending on benchmark results.

---

# 76. Vector scale

384-D float32:

```text id="4bwk0z"
384 × 4
= 1,536 bytes/vector
```

Approximate raw data:

```text id="gu339b"
100k  ≈ 154 MB
500k  ≈ 768 MB
1M    ≈ 1.54 GB
```

Full float scans are therefore not the expected large-scale retrieval path.

---

# 77. Compressed coarse retrieval requirement

Large semantic indexes require a compressed candidate-generation representation.

The exact representation is benchmark-selected.

Possible options:

```text id="j4v60j"
binary
int8
future stable ANN representation
```

The design does **not** assume binary quantization will be acceptable.

---

# 78. Candidate-generation pipeline

Conceptually:

```text id="kpb1rl"
query
   ↓
384-D query vector
   ↓
compressed query representation
   ↓
coarse retrieval
   ↓
top 200–1000 candidates
   ↓
accurate rerank
   ↓
semantic ranked list
```

Candidate count is intentionally generous when using lossy coarse representations.

Benchmark recall decides the final value.

---

# 79. Binary coarse option

384 bits:

```text id="5lhieq"
48 bytes/vector
```

Approximate raw index:

```text id="jxw765"
500k ≈ 24 MB
1M   ≈ 48 MB
```

Binary retrieval is retained only if recall is acceptable.

Arctic XS is not assumed to be naturally binary-quantization friendly.

---

# 80. Int8 coarse option

384-D int8:

```text id="3ycrb5"
384 bytes/vector
```

Approximate raw index:

```text id="xx764u"
500k ≈ 192 MB
1M   ≈ 384 MB
```

This may be preferable if binary recall is poor.

---

# 81. Accurate reranking

Benchmark:

```text id="evfbkn"
float32 rerank

int8 rerank

binary coarse + float rerank

binary coarse + int8 rerank

int8 coarse + float rerank
```

Production selection is driven by:

* Recall@K;
* MRR;
* query latency;
* memory;
* disk reads;
* browser stability.

---

# 82. Retrieval benchmark

Quixi maintains its own retrieval corpus.

Include:

* user-like questions;
* long assistant answers;
* technical conversations;
* code discussions;
* PDF passages;
* provider-switch conversations;
* similar-but-not-identical passages.

Example queries:

```text id="kuzq1s"
where did we decide to use OPFS?

discussion about Rust desktop wrappers

how were provider credentials stored?

the part where IndexedDB was rejected

PDF section discussing OAuth redirects
```

Measure:

* Recall@5;
* Recall@10;
* MRR;
* coarse-index Recall@100/500.

---

# 83. PDF implementation boundary

Quixi uses **PDF.js** for PDF parsing.

Quixi does not implement:

* PDF object parsing;
* xref;
* fonts;
* streams;
* PDF encryption internals

unless PDF.js later proves to be an actual blocker.

Quixi owns:

```text id="5hfhib"
PDF.js output
    ↓
structural normalization
    ↓
chunking
    ↓
FTS
    ↓
optional semantic embeddings
```

---

# 84. PDF UX

Example:

```text id="xkuyex"
research-paper.pdf

Extracting text
Page 14 / 86

Text search
✓ Available

Semantic indexing
23%

Backend
WebGPU

You can keep using Quixi.
```

FTS becomes useful before semantic indexing completes.

---

# 85. PDF memory rule

Never construct:

```text id="8aejbg"
whole PDF
+
whole extracted text
+
whole Markdown document
+
all chunks
```

in memory simultaneously.

Instead:

> **One page enters working memory, bounded chunks leave it, and the page is released.**

---

# 86. PDF pipeline

```text id="63d5t5"
PDF
 │
 │ bounded/range reads
 ▼
PDF.js Worker
 │
 │ one page
 ▼
text/layout extraction
 │
 ▼
Quixi structural normalizer
 │
 ▼
shared SearchChunk generator
 │
 ├──────────────► Storage Worker → FTS5
 │
 └──────────────► QuixiEmbed → vector index
```

---

# 87. PDF concurrency

Initial:

```text id="vii55d"
1 page
```

Increase only after memory/performance measurement.

---

# 88. Structural normalization

Preserve where practical:

* headings;
* paragraphs;
* lists;
* code;
* approximate tables;
* page boundaries.

Publication-perfect Markdown is not the goal.

Retrieval-quality structure is the goal.

---

# 89. Backpressure

All document-processing queues are bounded.

Example:

```text id="au7tz7"
pending SearchChunks ≤ 4
```

If downstream storage/inference falls behind:

```text id="eo5hhx"
PDF extraction pauses
```

Working memory depends on current work, not total PDF size.

---

# 90. Scanned PDFs

If little useful text is extracted:

```text id="8w9wna"
This document appears to contain scanned pages.

[Run OCR]
[Skip]
```

OCR is optional.

Pipeline:

```text id="meqguw"
one page
   ↓
bounded raster
   ↓
OCR
   ↓
SearchChunk
   ↓
FTS / semantic index
```

The image itself is not embedded.

---

# 91. Images

Images remain first-class attachments.

Searchable associated text may include:

* filename;
* surrounding messages;
* provider captions;
* descriptions;
* OCR text.

No visual semantic search in v1.

---

# 92. Appearance

Themes and interaction behavior are independent.

Built-in themes:

* Warm Reading;
* Cool Minimal;
* Compact Ops;
* Terminal;
* Bubbles;
* Focus.

Interaction settings include:

* Enter vs. Mod+Enter;
* timestamps;
* model badge visibility;
* composer layout;
* model switcher style.

---

# 93. Accessibility

Built-in UI requires:

* keyboard navigation;
* visible focus;
* accessible contrast;
* screen-reader semantics;
* scalable text;
* reduced motion;
* non-color-only status;
* accessible streaming announcements.

---

# 94. Onboarding

## Step 1 — Local storage

```text id="gm0a2i"
Your Quixi history stays on this device by default.

Nothing is stored in Quixi Cloud unless you enable it.
```

---

## Step 2 — Capability check

```text id="q2ib43"
Local storage
✓ SQLite WASM
✓ OPFS

Search
✓ FTS5

Semantic Search
✓ WASM SIMD
✓ WebGPU available
```

WebGPU is optional.

---

## Step 3 — Bring history

```text id="0tbd5y"
[Install Browser Extension]

[Import Provider Export]

[Import Quixi Archive]
```

---

## Step 4 — Connect providers

Connect now or later.

---

## Step 5 — Semantic search

```text id="kvlykb"
Enable Local Semantic Search?

Quixi can locally index the meaning of
your conversations and document text.

All inference stays on this device.

[Enable]
[Later]
```

---

# 95. Quixi Cloud

Quixi Cloud is optional and paid.

Potential capabilities:

* encrypted backup;
* attachment synchronization;
* multi-device sync;
* recovery;
* desktop/browser continuity.

---

# 96. Synchronization operations

Canonical mutations append `sync_ops`.

Examples:

```text id="7mjnd9"
CreateThread
CreateMessage
CreateGeneration
CompleteGeneration
CreateThreadEvent

SetTitle
SetTags
SetPinned
SetArchived
SetActiveBranch
SetRoutingProfile
```

Canonical mutation and sync operation are committed atomically in SQLite.

---

# 97. Derived data and sync

Do not normally synchronize:

* FTS indexes;
* embeddings;
* compressed semantic indexes;
* ranking caches.

These rebuild locally.

Benefits:

* reduced bandwidth;
* smaller cloud footprint;
* easier model upgrades;
* less coupling to embedding format.

---

# 98. Archive export

Every host supports:

```text id="hj9x4i"
[Export Quixi Archive]
```

Conceptually:

```text id="vi5gh3"
quixi.sqlite
blobs/
manifest.json
```

Derived search data may be excluded.

---

# 99. Open export

Also provide:

* JSONL;
* Markdown;
* attachment files.

The user must never need Quixi to decode the textual archive.

---

# 100. Diagnostics

Storage diagnostics:

```text id="s79qwv"
✓ SQLite integrity
✓ schema
✓ OPFS persistence
✓ FTS5
✓ sqlite-vec
✓ attachment references
```

Inference diagnostics:

```text id="nh5a8a"
✓ model hash
✓ tokenizer
✓ scalar golden
✓ WASM SIMD backend
✓ WebGPU backend
```

---

# 101. Quixi Doctor

Possible actions:

```text id="apmbsc"
SQLite integrity_check

rebuild FTS

delete/rebuild semantic index

verify blob hashes
find missing blobs
find orphan blobs

validate branches
validate import provenance
validate sync coverage

run QuixiEmbed self-test
```

---

# 102. Development structure

Development proceeds in parallel workstreams.

```text id="gzqcla"
                         QUIXI

        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
   Product Core       QuixiEmbed         Importers
        │                  │                  │
 storage/schema      model port          extraction
 chat/provider       WASM SIMD           normalization
 FTS/UI              WebGPU              deduplication
 switching           compressed vec      provenance
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                       integration
```

---

# 103. Track A — Product Core

## A1. Universal storage proof

Implement:

```text id="ukv71j"
Storage Worker
SQLite WASM
FTS5
sqlite-vec
OPFS
```

Validate on supported hosts.

This phase decides the minimum browser/WebView support matrix.

---

## A2. Canonical conversation model

Implement:

* Thread;
* ThreadState;
* Message;
* Generation;
* ContentPart;
* ThreadEvent;
* branching.

---

## A3. First provider adapters

Implement:

* OpenAI-compatible;
* Anthropic.

Support:

* streaming;
* capabilities;
* token accounting;
* cost metadata.

---

## A4. Main chat UI

Implement:

* thread library;
* composer;
* streaming;
* branches;
* model/account selector;
* attachments;
* settings.

At this point users can chat.

---

## A5. FTS5 global search

Search all canonical text.

At this point Quixi already supports:

* chat;
* persistent history;
* lexical search.

---

## A6. Provider switching

Implement:

* aliases;
* account health;
* routing;
* fallback;
* portability;
* Compatibility Inspector.

---

## A7. Export

Implement:

* Quixi archive;
* JSONL;
* Markdown.

This forms the minimum complete Quixi product.

---

# 104. Track B — Historical Import

## B1. Import framework

Implement:

* ProviderImportBundle;
* normalization;
* provenance;
* deduplication;
* raw preservation;
* import reports.

---

## B2. Browser extension

Implement provider extraction.

Provider-specific permission/terms review is required before shipping each extractor.

---

## B3. Incremental import

Implement:

```text id="omkmx2"
Import new conversations
```

with stable identity and deduplication.

---

## B4. Large-import testing

Test:

```text id="u6ea35"
100k threads
1M+ messages
large attachments
```

without archive-wide memory materialization.

---

# 105. Track C — QuixiEmbed

QuixiEmbed is intended for v1 integration but does not gate product-core usability.

## C0. Port specification

Freeze:

* checkpoint;
* hash;
* graph;
* tokenizer;
* tensor inventory;
* query/document semantics;
* goldens.

---

## C1. Scalar reference

Implement the complete Arctic XS graph.

Goal:

```text id="3jj39b"
correctness first
```

---

## C2. WASM SIMD

Implement model-specific SIMD kernels.

Retain scalar implementation as correctness oracle.

---

## C3. WebGPU

Implement:

1. FP32 correctness;
2. persistent weights;
3. static scratch allocation;
4. FP16;
5. kernel specialization;
6. fusion;
7. autotuning.

---

## C4. Model compiler

Implement `.qxmodel` generation:

* verification;
* packing;
* transposition;
* precision conversion;
* quantization;
* checksums.

---

## C5. Scheduler

Implement:

* priorities;
* dynamic batching;
* bounded queues;
* duplicate singleflight;
* result cache.

---

## C6. Semantic integration

Implement:

* `embed_query`;
* `embed_document`;
* chunk indexing;
* query path;
* `sqlite-vec`.

---

## C7. Compressed large-index retrieval

Benchmark:

* binary coarse;
* int8 coarse;
* float rerank;
* int8 rerank;
* candidate counts.

The production path is selected by retrieval benchmark, not assumption.

---

# 106. Track D — Documents

## D1. PDF.js pipeline

Implement:

* bounded reads;
* one-page extraction;
* cleanup;
* structural normalization.

---

## D2. Shared SearchChunk pipeline

Feed PDF text into the same chunking/indexing abstraction used by chat messages.

Insert into FTS immediately.

---

## D3. Semantic integration

When QuixiEmbed is enabled:

```text id="0adgm4"
SearchChunks
    ↓
embedding queue
```

---

## D4. OCR

Optional local OCR for scanned PDFs.

Not required for normal text PDFs.

---

# 107. First usable build

Must support:

```text id="0kefkz"
local storage
chat
at least two providers
history
FTS search
export
```

This is the first internal milestone worth using daily.

---

# 108. First compelling migration build

Adds:

```text id="k3mqdb"
browser-extension import
incremental import
provider switching
compatibility inspection
```

This satisfies Quixi's central product thesis.

---

# 109. Semantic-search build

Adds:

```text id="0z84gx"
QuixiEmbed
hybrid RRF search
PDF/document embeddings
compressed large-index retrieval
```

This may land in v1 if ready.

The core product must not wait solely because semantic-search optimization is unfinished.

---

# 110. Release/platform risks

These are explicit implementation gates, not reasons to redesign the architecture.

## 110.1 Linux Desktop

Do not promise Linux Desktop support until A1 verifies the required OPFS behavior in the WebKitGTK versions Quixi intends to support.

WebGPU absence does not block semantic search because WASM SIMD exists.

Failure of the required OPFS path does block the universal-storage architecture.

Therefore:

> **Linux Desktop support is provisional until A1 passes.**

---

## 110.2 Safari/quixi.ai durability

Quixi must test:

* OPFS persistence;
* `navigator.storage.persist()`;
* actual eviction behavior;
* storage quota behavior;
* long-running imports.

The UI distinguishes clearly between persistent-storage granted/not granted.

Users should be encouraged to export backups or enable Cloud backup for valuable archives.

---

## 110.3 Browser-extension provider rules

Each provider importer requires a provider-specific review of:

* technical extraction method;
* requested extension permissions;
* applicable provider terms;
* authentication/session handling.

Do not promise import support solely because extraction is technically possible.

---

## 110.4 Quixi Cloud key recovery

Cloud key management and recovery remain unresolved until the Cloud phase.

This does not block local-first v1.

Do not weaken local encryption architecture merely to make account recovery easier.

---

# 111. Storage stress tests

Target:

```text id="6vjphs"
100,000 threads
1,000,000 messages
10–50 GB attachments
```

Test:

* startup;
* import;
* FTS;
* migrations;
* quota exhaustion;
* multi-tab ownership;
* archive export;
* archive restore;
* interrupted writes.

---

# 112. Semantic-search stress tests

Target:

```text id="0659s7"
100k vectors
500k vectors
1M vectors
```

Measure:

* float scan;
* int8 coarse;
* binary coarse;
* rerank cost;
* RRF latency;
* full query latency;
* memory pressure;
* OPFS reads;
* WASM overhead.

---

# 113. QuixiEmbed benchmarks

Measure:

```text id="2pumlt"
WASM SIMD
WebGPU FP32
WebGPU FP16
```

At:

```text id="3wwbqi"
batch 1
batch 4
batch 8
batch 16
batch 32
```

Track:

* cold model load;
* warm latency;
* chunks/second;
* tokens/second;
* memory;
* GPU memory;
* dispatch overhead;
* readback overhead.

---

# 114. PDF stress tests

Test:

* 1 page;
* 100 pages;
* 1,000 pages;
* very large PDFs;
* image-heavy PDFs;
* multi-column layouts;
* tables;
* malformed PDFs;
* encrypted PDFs;
* scanned PDFs.

Measure:

* peak memory;
* extraction throughput;
* FTS availability time;
* semantic indexing throughput;
* cancellation;
* resume.

---

# 115. V1 success criteria

Quixi v1 succeeds when a user can:

1. open Quixi Desktop or `quixi.ai`;
2. initialize SQLite WASM over OPFS;
3. remain entirely local;
4. connect multiple providers;
5. send and stream messages;
6. import existing provider history;
7. search imported history with FTS5;
8. open an old conversation;
9. continue it with another provider;
10. inspect compatibility transformations;
11. import and search PDF text;
12. optionally enable local semantic search;
13. run QuixiEmbed through WebGPU when available;
14. run QuixiEmbed through WASM SIMD otherwise;
15. hybrid-search chats and document text;
16. pause/resume semantic backfill;
17. export a complete local archive;
18. restore that archive elsewhere;
19. do all of this without Quixi persistently storing their history.

---

# 116. Product-core success criteria

Even if semantic indexing is completely disabled:

```text id="uhx8p4"
import
chat
FTS-search
switch providers
export
```

must all work.

This is a hard requirement.

---

# 117. QuixiEmbed success criteria

QuixiEmbed is production-ready when:

* tokenizer matches reference;
* scalar implementation matches reference;
* WASM SIMD passes numerical thresholds;
* WebGPU passes numerical thresholds;
* retrieval benchmark passes;
* memory is bounded;
* intermediate GPU tensors stay resident;
* no generic inference runtime is needed;
* interactive queries preempt background indexing;
* compressed retrieval works at large-index scale;
* indexing exposes realistic speed/ETA;
* all retained optimizations have benchmark evidence.

---

# 118. Explicit v1 non-goals

Not required:

* image embeddings;
* visual similarity search;
* custom multimodal training;
* native voice;
* autonomous agents;
* computer use;
* native mobile apps;
* provider-project clones;
* semantic-index synchronization;
* public theme marketplace.

---

# 119. Product differentiation

Quixi's differentiated stack is:

```text id="2q4vnt"
historical import
      +
provider-neutral conversation model
      +
universal local storage
      +
cross-provider continuation
      +
compatibility inspection
      +
FTS over all history
      +
optional local semantic search
      +
Quixi-owned inference
      +
portable encrypted sync
```

---

# 120. Final architecture

```text id="a7na8g"
                                  QUIXI

                          Canonical Local History
                                   │
             ┌─────────────────────┼─────────────────────┐
             │                     │                     │
             ▼                     ▼                     ▼
        Conversations          Documents            Attachments
             │                     │                     │
             └─────────────────────┼─────────────────────┘
                                   │
                            SearchChunk Layer
                                   │
                 ┌─────────────────┼─────────────────┐
                 │                                   │
                 ▼                                   ▼
               FTS5                              QuixiEmbed
                 │                                   │
             BM25 ranks                      Arctic Embed XS
                 │                                   │
                 │                           fixed model graph
                 │                                   │
                 │                      ┌────────────┴────────────┐
                 │                      │                         │
                 │                   WebGPU                    WASM
                 │                      │                         │
                 │               Quixi WGSL               C/Rust SIMD
                 │                      │                         │
                 │                      └────────────┬────────────┘
                 │                                   │
                 │                             384-D vectors
                 │                                   │
                 │                               sqlite-vec
                 │                                   │
                 └──────────────────┬────────────────┘
                                    ▼
                             Reciprocal Rank Fusion
                                    │
                                    ▼
                               Search Results

                         Storage Worker beneath all
                                    │
                              SQLite WASM
                                    │
                                   OPFS

                         same runtime on every host

                  ┌────────────────┬────────────────┐
                  │                │                │
               Tauri           quixi.ai        Docker Web
                  │                │                │
                  └────────────────┼────────────────┘
                                   │
                        optional encrypted sync
                                   │
                              Quixi Cloud
```

The governing engineering rules are:

> **Own the user's canonical history.**

> **Use one storage backend everywhere.**

> **Make FTS part of the product core.**

> **Use one shared SearchChunk abstraction for conversations and documents.**

> **Use Reciprocal Rank Fusion for v1 hybrid ranking.**

> **Treat semantic search as derived and optional, but make it excellent when enabled.**

> **Own the embedding runtime down to model-specific WASM SIMD and WGSL kernels.**

> **Use a real text-retrieval encoder because text is the dominant Quixi corpus.**

> **Require compressed retrieval for large semantic indexes, but choose binary vs. int8 from benchmarks.**

> **Use PDF.js for PDF parsing and own the semantic processing after parsing.**

> **Do not embed images in v1.**

> **Keep large-document and large-import memory bounded by working-set size, not archive size.**

> **Keep the user's archive local unless they explicitly choose otherwise.**

> **The next architectural revision should be driven by A1 and the first real importer, not by further speculative redesign.**
