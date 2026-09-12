# 0013: Continuous streaming text with ordered transport evidence

Date: 2026-09-08  
Status: Implemented; core, pinned SQLite WASM and controlled browser acceptance pass

The [generation](../product.md#18-generation), [content-part](../product.md#19-content-parts)
and [chat](../product.md#29-core-chat-experience) contracts require durable streamed
output and preserved provider evidence. Previously, each raw network checkpoint
closed the current text part. A single sentence could become many independent
search sources, preventing lexical matches across stream events.

The latest unfinished semantic Text part may now append across only these two
reserved ProviderArtifact kinds: `quixi.provider.raw-stream-chunk` and
`quixi.provider.response-manifest`. Any other part closes the preceding text
block, including unknown provider artifacts. Raw evidence retains its original
IDs, bytes and part order. Its position describes transport evidence order;
it does not freeze the earlier semantic text at that checkpoint's length.
The durable sync operations retain each text delta and exact checkpoint sequence.

Provider generation keeps one active text segment for the current adapter text
key, capped at 8,192 UTF-16 code units without cutting a surrogate pair. A changed
key or semantic part starts another segment. Every delta still commits before
the reader advances; same-operation retry does not append twice. Terminal
generations remain immutable. Derived search invalidates the changed Text source
through the existing dirty-source machinery.

Core exports the reserved-part predicate; model-input preparation and shared
rendering use it. Both the pure canonical transition and SQL repository enforce
the latest-semantic-part rule. Migration 8 replaces the database append trigger
and compares the old text prefix as UTF-8 bytes, including bytes after embedded
NUL characters. Earlier migration SQL and ledger identities are unchanged.

The schema-7 upgrade test preserves canonical records and all seven old ledger
entries before accepting the new append behavior. Regression tests reject edits
to raw evidence, prefix rewrites, appends behind semantic barriers and sealed
content. Chromium and WebKit application tests verify exact long Unicode output
and search terms spanning distinct network events. See
[shared application acceptance](../validation/shared-app.md).

Portable archive format remains version 1; its manifest records the source
schema and complete migration ledger. Restore currently requires the exact
supported schema, so a schema-7 portable archive is rejected by the schema-8
reader. Migrating older portable archives in isolation is still an explicit
compatibility gate; changing the live database does not establish that support.
