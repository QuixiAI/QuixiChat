# Bounded importer implementation notes

Status: implementation in progress; this is an engineering decision record, not a claim of provider compatibility.

The importer consumes replayable, range-readable byte sources supplied by host/UI adapters. A source returns chunks no larger than 1 MiB; the importer retains exact bytes through the public blob transfer API. The SAX parser emits byte offsets, bounded paths and string fragments. It never parses a whole export, thread, message or unlimited string into a JavaScript object. Keys, nesting and bounded scalar metadata have explicit supported limits; rejected input retains its raw source and reports an error.

A durable, worker-owned generic work index handles arbitrary property/node order and unusually large threads. Each run/group/node work key retains byte ranges, bounded scalar metadata, a parent dependency and a resolved result. Ready-node paging waits for the parent result; provider policy and normalization stay in this package. Structural nodes can resolve to the closest retained canonical ancestor. A sealed group with unresolved rows and no ready row has missing/cyclic dependencies and cannot silently publish.

Entity and control UUIDs are injected random UUIDv4 values allocated once under stable run/phase/source-locator keys in SQLite. Resume or unknown outcome resolves the existing allocation. Do not disguise a deterministic digest as a random UUIDv4 or change the shared ID validator.

Source identity uses provider/account/native-thread/container/native-entity keys. New revisions additionally key a fingerprint of the source message representation and resolved canonical parent. The base native identity mapping remains stable; prior immutable history and raw provenance remain retained. A changed message with the same canonical parent/role can link as an edit; a changed parent/role requires a new retained message plus an explicit import warning, not an invalid edit backlink. Thread titles never identify a conversation. Extend mode preserves existing user ThreadState and active selection.

The scanner records bounded message/part/attachment work rows, not a per-message part manifest. Message metadata contains counts and raw ranges; part rows depend on their message work result. Normalization stages the sealed Message with its final part count and then streams part records. A single long text value becomes a verified UTF-8 blob. Unknown large structured content becomes a ProviderArtifact with a raw-source locator. Raw captures and text blobs use prepareImportBlobs before validation, so thousands of verified transfer IDs do not become a control manifest. Canonical visibility still waits for complete normalized group publication.

Cancellation pauses the run with its current thread hidden and work/checkpoints retained. Previously published threads remain imported. Explicit discard cancels unfinished normalized groups and permits transfer cleanup. Reports distinguish published, skipped, failed and paused work; completed control replay returns historical results, while status APIs provide current state. Provider export decoding, normalized staging and raw/blob staging are separate checkpoints.

The first declared profile covers evidence-backed ChatGPT mapping exports. It retains every supported branch instead of flattening to the active path; current_node selects initial state only when proven resolvable. Absent attempt/context facts do not become fabricated successful Generations. Unknown formats and unsupported content transformations require visible warnings and exact raw preservation. Claude personal export support follows the shared path after the ChatGPT milestone.

## Format evidence checked 2026-09-08

OpenAI documents ZIP export and conversations.json, with numbered conversation JSON files possible for large exports: [export help](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data), [transfer help](https://help.openai.com/en/articles/9106926). These pages do not publish a complete field-level schema.

Maintainer evidence from [Our Dialogues](https://github.com/willwefind/our-dialogues/tree/f3bed09f67ab91bfa466737923d7828b839a95fb) describes validation against a 2026 official export and provides explicitly synthetic ChatGPT and Claude fixtures. Field observations include ChatGPT id/conversation_id, mapping node parent/message, author.role, content.content_type/parts, current_node and source timestamps. The synthetic folder manifest has version 1 and files entries with name and optional shards names. Claude observations include uuid/name/times/chat_messages, sender/content and parent_message_uuid. This is primary maintainer evidence for an observed profile, not an official schema or an actual private export in this repository. Implementation and fixture content here are original; upstream application code and fixtures are not copied.

A captured representative official export has not been supplied. Do not mark that compatibility acceptance gate complete based on synthetic fixtures alone. The current field evidence is stronger than the earlier LangChain loader subset but does not establish every current provider format.

## Implemented vertical path (2026-09-08)

The package now implements both observed consumer-export adapters, bounded SAX/range scanning, durable source capture, SQL work dependencies, staged normalized publication, source-identity/revision handling, verified text blobs, missing attachment preservation and later byte resolution, original ZIP/ZIP64 capture and streamed entries, exact-path assets, exclusive run executor leases, and bounded NDJSON reports. See the [package README](../README.md) for the exact contracts, limits, and remaining format/UX gates.

Pure package tests use an actual pinned SQLite WASM/MEMFS repository behind `StorageClient` and explicitly doubled bytes. A separate production browser harness is `tests/browser/run.mjs`, using the actual owner worker and OPFS. Do not confuse either the synthetic shape fixtures with actual official-export captures or the Node byte adapter with browser persistence evidence.
