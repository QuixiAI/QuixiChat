# Canonical history fixtures

All conversations, names, identifiers, file metadata, tool values and payload text here are original synthetic test data, distributed under the repository's [MIT license](../../../LICENSE). They contain no personal conversation exports, credentials or copied provider answers. Source documentation informs field shapes, not fixture content.

These are worked normalization **expectations**, not executable importers. Each `*.history.json` is a complete version-1 canonical graph validated by `@quixi/core/model`. Each retained raw object records the exact companion file's SHA256 and byte length. Tests resolve every provenance JSON Pointer, verify those bytes and round-trip the canonical graph through JSON. Changing a raw fixture requires updating its recorded digest and size.

## Native conversation and branching

`native-branches.history.json` and `native-branches.expected.json` cover native multi-provider candidates, edits, partial failures, stopped and streaming attempts, tool calls/results, unsupported raw content, a missing attachment and canonical document metadata. `native-provider-response.synthetic.json` supplies exact retained bytes for the unsupported provider block.

For readability these diagrams show only the final decimal suffix of each Quixi UUID. These are synthetic IDs, not production UUID allocation logic.

```text
implicit thread root (thread 10, context 11)
├─ 100 user: two-day trip
│  ├─ 101 assistant / generation 200 / Anthropic complete
│  └─ 102 assistant / generation 201 / OpenAI complete
│     └─ 103 user: include a map, missing attachment 400
│        ├─ 104 assistant / generation 202 / failed with retained prefix
│        └─ 105 assistant / generation 203 / tool call
│           └─ 106 tool / result linked to call part 1105
│              └─ 107 assistant / generation 204 / complete + raw artifact
└─ 108 user: three-day trip (editedFrom 100)
   ├─ 109 assistant / generation 205 / stopped with retained prefix
   └─ 110 assistant / generation 206 / currently streaming
```

The active path is explicitly `[100, 102, 103, 105, 106, 107]`. Selecting 109 changes only ThreadState. Creating the edit 108 preserves 100 and every descendant of 100. An edit of generated message 102 creates a new user-authored assistant sibling with no generation backlink. Generation 206 reserves output 110; checkpoint sequence 1 may append to its text, and any terminal transition seals it. Failed, stopped and cancelled attempts keep received prefixes.

Document 450 points to logical attachment 400. Its user-visible title/workspace/identity are canonical even though the bytes are missing. Later extraction, OCR, chunks and vectors remain derived. Resolving attachment 400 publishes verified bytes through its stable reference without rewriting message 103's sealed parts. Adding a different attachment to 103 requires an edit.

## Claude documented API shape

`claude-compliance.synthetic.json` follows a limited subset of the documented Claude Compliance API chat-message response, checked on 2026-09-08: conversation metadata, `chat_messages`, role/time, text and tool blocks, file metadata and artifact metadata. Official evidence: [list chat messages](https://platform.claude.com/docs/en/api/http/compliance/apps/chats/messages/list) and [Compliance content data](https://platform.claude.com/docs/en/manage-claude/compliance-content-data).

`claude-compliance.history.json` retains the two source messages as canonical 120 → 121, with a warning that this source order is the basis of the linear path. It preserves same-message call/result grouping, provider-native IDs in separate SourceIdentity records, exact raw provenance, absent file bytes, redacted reasoning metadata and unsupported artifact metadata. `quixi_fixture_unknown` is deliberately invented to test forward compatibility; it is **not** claimed to be an Anthropic content type. A null source model and absent per-attempt facts do not become a fabricated successful Generation.

This is a synthetic API-response-shaped fixture. It is not a captured Claude personal export, and does not demonstrate compatibility with one. [Claude's export help](https://support.claude.com/en/articles/9450526-export-your-claude-data) establishes export availability but does not supply a complete current personal-export schema.

## ChatGPT consumer-export-shaped example

`chatgpt-conversations.synthetic.json` is an original, deliberately small `conversations.json`-shaped example. Its evidence is the maintained [LangChain ChatGPT loader documentation](https://docs.langchain.com/oss/python/integrations/document_loaders/chatgpt_loader) and [loader source](https://raw.githubusercontent.com/langchain-ai/langchain-community/main/libs/community/langchain_community/document_loaders/chatgpt.py), checked on 2026-09-08. That loader represents `title`, `mapping`, `message.author.role`, `message.content.parts`, and `message.create_time`. This is primary evidence for the loader's represented export shape, **not an official OpenAI schema or proof of complete/current export compatibility**. No upstream example text or code was copied.

`chatgpt-conversations.history.json` maps the three records to 130 → 131 → 132 with an explicit inferred-order warning. The limited source does not establish parent edges, active branch, thread ID, exact attempt/model facts or system-prompt configuration; none is presented as recovered fact. Source mapping keys stay provider-native IDs, scoped by `sourceContainerKey = fingerprint + entry locator` because the native thread ID is absent. The title is never used as identity. The imported system-role message remains a message; it does not silently become the thread's configured prompt.

Plan 04 still requires actual format adapters and appropriate compatibility evidence. These fixtures satisfy plan 02's representative redistributable model example; they do not close that importer evidence gap.

## Negative cases and executable evidence

`invalid-cases.json` patches the native graph to introduce dangling/cyclic parents, invalid active selection, mismatched generation/part ownership, falsely available missing bytes, invalid edits/tool references/times and unsealed terminal output. Tests assert stable model error codes. Additional pure tests cover cross-thread references, source-ID collisions, edit cycles, 10,000-message chains, bounded root tombstones, partCount/ordered paging, inline/blob text exclusivity and all 23 canonical mutation kinds and their effects, operation-ID retries, attachment immutability, document references, checkpoint lifecycle, bounded request/reply preflight, blob metadata, cancellation IDs and byte-transfer backpressure.

Run from the repository root:

```sh
npm run typecheck --workspace @quixi/core
npm run typecheck:tests --workspace @quixi/core
npm test --workspace @quixi/core
```

Source typechecking uses ES2022 with no ambient DOM or Node types. Node types are enabled only for the separate test compilation. SQL transactions, OPFS publication/recovery, actual provider adapters and host effects require the later integration tests; pure transition previews do not establish those guarantees.
