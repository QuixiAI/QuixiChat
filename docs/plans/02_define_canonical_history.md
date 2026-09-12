# 02 — Define canonical history and shared contracts

**Status:** Complete — scale corrections and updated core acceptance evidence verified on 2026-09-08

**Workstream:** A2 — canonical model

**Depends on:** [01](./01_prove_universal_storage.md)

## Outcome

Define a provider-neutral history model and the contracts needed to store, import, display, branch, and eventually synchronize it without losing source fidelity.

## Product references

- [8. Host architecture](../product.md#8-host-architecture)
- [16. Canonical conversation model](../product.md#16-canonical-conversation-model)
- [17. Message](../product.md#17-message)
- [18. Generation](../product.md#18-generation)
- [19. Content parts](../product.md#19-content-parts)
- [20. Branching](../product.md#20-branching)
- [21. Raw provider preservation](../product.md#21-raw-provider-preservation)
- [22. Thread events](../product.md#22-thread-events)
- [26. Import provenance](../product.md#26-import-provenance)
- [47. SearchChunk](../product.md#47-searchchunk)
- [96. Synchronization operations](../product.md#96-synchronization-operations)
- [97. Derived data and sync](../product.md#97-derived-data-and-sync)

## Tasks

- [x] Implement Thread, ThreadState, Message, Generation, ContentPart, and ThreadEvent types and validation in core/model, following the entities and states in the specification.
- [x] Make relationships explicit: message parentage, generation attempts, produced content, sibling candidates, active leaves, and continuation paths. Resolve how these entities represent an imported branch and record the decision with worked examples.
- [x] Define stable identity, timestamp representation, mutable versus immutable fields, deletion behavior, and referential invariants before creating migrations. Preserve provider-native IDs separately from Quixi IDs.
- [x] Define serializable StorageClient, HostClient, import-bundle, progress, and error contracts in core/contracts. Specify cancellation and bounded transfer where bulk work crosses a worker boundary.
- [x] Define SearchChunk source references and version metadata without making canonical content depend on an embedding model. Keep raw source and compatibility metadata linked to their owners.
- [x] Define canonical mutation operations and atomic sync-op coverage, including edits, generation lifecycle, thread-state changes, and attachment references. Record unresolved sync transport concerns for plan 25.
- [x] Validate the model against small synthetic native conversations and a representative, redistributable provider-export fixture, including branches, failed generations, tool records, and missing attachments.

## Deliverables and interfaces

- Canonical types, pure branch traversal/validation rules, and shared boundary contracts.
- Worked fixtures and a short schema/relationship decision record consumed by plans 03, 04, 06, and 08.

## Acceptance criteria

- [x] The same conversation can preserve multiple providers, edits, generation candidates, and an active path without rewriting prior history.
- [x] Fixtures retain raw provenance and unsupported parts; malformed relationships produce explicit validation errors.
- [x] Core imports no DOM, Tauri, SQLite implementation, provider transport, or embedding runtime.

## Implementation and acceptance evidence

- [Canonical relationship decision](../decisions/0004-canonical-history.md), [core exports](../../packages/core/README.md), and [worked synthetic fixtures with source citations](../../tests/fixtures/canonical/README.md).
- `@quixi/core/model` implements the entities, graph validators, branch traversal, edits, active selection, generation checkpoint/finalization rules, logical tombstones, source identity/provenance, attachment/document metadata and derived SearchChunk validation.
- `@quixi/core/contracts` defines 24 canonical mutations and complete effect declarations, pure mutation/batch previews, operation-ID replay comparison, explicit caller cancellation IDs, bounded JSON request/reply preflight, standalone staged blob transfer, import manifests and privileged HostClient lifecycle contracts.
- Passed on 2026-09-08: `npm run typecheck --workspace @quixi/core`, `npm run typecheck:tests --workspace @quixi/core`, and `npm test --workspace @quixi/core` (37 tests, no failures/skips). Source-only typechecking uses ES2022 without DOM/Node ambient types. The Node test configuration is separate.
- Tests preserve multi-provider candidates and edited history, all terminal generation states, tool relationships, exact raw bytes/provenance, unsupported blocks, missing attachments/documents, active paths, explicit malformed-graph errors, bounded transfer/serialization and every mutation's sync coverage.

The redistributable provider examples are original synthetic data: a documented Claude Compliance API response shape and a ChatGPT consumer-export shape supported by the maintained LangChain loader. They establish model coverage, not an official current complete personal-export schema or a working importer. Plan 04 retains that evidence/adapter work. SQL durability, migrations, idempotent persistence and OPFS publication/recovery remain plan 03; core's pure previews do not claim these integration guarantees.

## Plan 03 integration corrections

The first storage review exposed three archive-scale payload problems. The accepted model now uses bounded root-scope tombstones, `Message.partCount` with authoritative ordered ContentPart records and cursor paging, and Text/Note with exactly one bounded inline value or verified UTF-8 blob reference. Monotonic local sync sequence/paging and full product privacy classes are also represented. The current core suite passes 47 tests and both source/test typechecks (2026-09-09). Subsequent coverage includes archive selection, full activation identity, extraction source/page bounds and UTF-16 source maps. Prior 34/37-test captures remain historical evidence.

These contracts support bounded storage without limiting total archival text or part count. Implementing staged complete-thread publication and many-part sealed imported messages remains explicitly unfinished plan 03 work; plan 04 consumes that import storage path.

## Boundaries and sequencing

The spec supplies conceptual entities, not a complete relational schema. Resolve representational gaps here and publish the results before downstream implementations diverge. Do not copy the prototype’s flat turns array as the canonical model.

[Back to the roadmap](./README.md)
