# 04 — Import provider exports with provenance

**Status:** In progress — importer, application workflow, warning handling and all acceptance criteria pass repository and production-browser checks; the only open task is actual official-export qualification, blocked on redistributable official export captures

**Workstream:** B1/B3 — historical import

**Depends on:** [02](./02_define_canonical_history.md), [03](./03_build_storage_repositories.md)

## Outcome

Let a user import existing provider history, preserve its original representation, and safely repeat an import to collect new or changed conversations.

## Product references

- [3. Product pillars](../product.md#3-product-pillars)
- [21. Raw provider preservation](../product.md#21-raw-provider-preservation)
- [23. Historical import](../product.md#23-historical-import)
- [25. Incremental import](../product.md#25-incremental-import)
- [26. Import provenance](../product.md#26-import-provenance)
- [27. Import transactions](../product.md#27-import-transactions)
- [28. Import UX](../product.md#28-import-ux)
- [104. Track B — Historical Import](../product.md#104-track-b--historical-import)
- [116. Product-core success criteria](../product.md#116-product-core-success-criteria)

## Tasks

- [x] Define the bounded ProviderImportBundle ingestion pipeline: validate, normalize, reconstruct branches, identify attachments, preserve raw records, and produce an import report.
- [ ] Start with a representative official ChatGPT export and add a Claude export adapter once the shared pipeline works. Inspect actual fixtures and document supported source-format versions; never guess provider fields.
- [x] Implement identity precedence using provider IDs, independently unique stable metadata where established, then explicitly heuristic deterministic fingerprints. Define changed-record handling and conflict reporting while retaining prior source provenance.
- [x] Stream archive entries and logical threads into bounded storage commits. Add cancellation, progress, checkpoint/retry behavior, and explicit handling for a single unusually large thread.
- [x] Handle unsupported content, missing attachments, malformed records, and unavailable source data with retained raw material and visible warnings. Keep titles out of identity decisions. Unsupported parts, missing attachment bytes and malformed message records each produce a retained-source warning shown in the panel's notice review (repository tests plus the production panel run in both engines); a resume whose original bytes were never fully saved is refused with an explicit request to choose the same file again; the content fingerprint excludes titles.
- [x] Connect import selection, progress, warning review, retry, and report export to the shared application. Explain estimated canonical, attachment, and derived storage separately. The shared import panel selects a real host file, shows phase progress, lists saved runs for resume after pause or restart, reviews bounded notices, exports a report through host staging, discards unfinished work, and explains original-file, conversation, attachment and search storage separately; see the [panel acceptance](../../packages/importers/docs/validation.md#shared-react-workflow-acceptance).
- [x] Create small format/branch fixtures and a synthetic large-import generator; record importer name/version and source fingerprints in stored provenance.

## Deliverables and interfaces

- Shared import pipeline plus versioned provider-export adapters in packages/importers.
- Import reports, progress/cancellation contracts, and redistributable test fixtures.

## Acceptance criteria

- [x] Importing the same export twice creates no duplicate canonical threads/messages or blobs. Repository test and the production panel run (same file, same account: thread, message and part counts unchanged) in Chromium and WebKit.
- [x] Importing changed source data adds or updates the intended records while preserving branches, raw source, and provenance. Repository test and the production panel run (an edited user message adds sealed revisions in the same thread while the original text and raw source remain) in both engines.
- [x] Cancellation and restart resume bounded work without re-materializing the archive or silently skipping failures. Pause during an actual storage acknowledgment, resume after a real browser-process restart, explicit discard and unmount cancellation are in the same panel run; lost-acknowledgment recovery is in the repository suite.
- [x] Imported content remains usable without access to the original provider account or semantic indexing. The panel harness has no provider credentials or embeddings; imported text is opened as a conversation and found by exact lexical search in the same run.

## Implementation evidence and remaining gates

The [shared importer](../../packages/importers/README.md) now preserves raw JSON and original ZIP/ZIP64 bytes, normalizes two observed synthetic consumer-export profiles, reconstructs branches through durable SQL dependency work, publishes complete normalized threads, streams long text/attachments, retains unknown content, resumes from retained source bytes, and exports bounded reports. [Validation evidence](../../packages/importers/docs/validation.md) distinguishes actual pinned SQLite tests from the separate production browser/OPFS harness.

Native IDs remain separate from Quixi UUIDs. Non-unique display or timestamp metadata is not treated as identity; missing native thread identity falls through to an explicitly labeled content fingerprint. Changed message observations retain sealed prior history. Missing attachment bytes can be resolved later; changed bytes for an already published attachment require explicit revision reconciliation and are not overwritten.

On 2026-09-09 the production panel run also imports the same synthetic export twice without new canonical records, imports an edited copy that adds sealed message revisions while retaining the original text and raw source, and finds the imported text by exact lexical search with no provider connected; both engines pass twelve check groups. A repeated import may register a further raw source observation, which is provenance rather than duplicated history. A malformed message record is now skipped with a visible notice while the rest of its export imports (repository test and thirteenth panel group on 2026-09-09). The official-export task remains unchecked: current fixtures are original synthetic examples backed by cited shape observations, not actual official-export captures. The production browser suite passes in Chromium and WebKit, including actual owner-tab termination and browser-process restart. The exported shared React import panel now passes production Chromium/WebKit tests for file selection, progress, warning/report review, pause, restart/resume, safe discard and active unmount. Three actual SQLite tests also cover discard after unknown publication outcomes. Storage estimates distinguish known original-file size from still-unknown canonical/attachment/derived estimates. Final application composition and desktop workflow qualification remain open; see the linked validation report.

## Boundaries and sequencing

Export parsing is separate from live provider adapters and extension extraction. Unknown export versions require an explicit support decision. The extension in plan 11 reuses this pipeline rather than defining its own normalization policy.

[Back to the roadmap](./README.md)
