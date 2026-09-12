# ADR 0031 — Durable complete thinking-block capture

Date: 2026-09-10. Status: accepted. This is a prerequisite for reasoning
continuation in plan 06; request-side continuation remains open.

## Protocol review

The [Anthropic Messages input contract](https://platform.claude.com/docs/en/api/messages/create)
requires the original thinking text and signature, or the opaque data of a
redacted block, in original block order. The [thinking guide](https://platform.claude.com/docs/en/build-with-claude/thinking)
describes signature deltas before block closure, empty display text, and opaque
redacted data. These values must not be trimmed, summarized, decrypted or
reconstructed from a display summary. Both sources were fetched on 2026-09-10.

The reviewed Haiku 4.5 supports manual thinking, not adaptive or interleaved
thinking. Its [manual-mode contract](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
requires at least 1,024 budget tokens and a budget below the output ceiling.
Enabling it therefore needs a separate, capability-driven parameter contract;
this capture change does not silently enable generation-time thinking.

The [OpenAI Chat Completions assistant-message contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
fetched on 2026-09-10, has no Anthropic thinking/signature input representation.
Preserving these blocks does not make them portable to that adapter. Responses
reasoning state is a separate API contract, outside the implemented Chat
Completions profile.

## Problem and decision

The existing normalizer emits a ReasoningMetadata marker at block start and
retains all original TCP/SSE bytes. Its artifact locator identifies a record in
the complete stream; the referenced TCP chunk can contain only part of that
record. A marker or its nearest raw chunk is insufficient evidence for a
complete signed input block.

Keep that original evidence and add an explicit `reasoning_block` provider
event at a successful `content_block_stop`. Assemble thinking text and signature
fragments in order, preserving exact string values, including whitespace, BOMs,
Unicode and opaque fields. Redacted blocks preserve their data unchanged.
Missing signatures, unsupported fields/deltas, late thinking after signing,
invalid indexes and oversized captures fail the stream explicitly. Incomplete
blocks never receive a complete-block event.

The normalizer admits at most 64 open thinking blocks, 256 KiB of escaped JSON
per block, and 1 MiB per generation. Credit is charged before concatenation and
is not reset when a block closes. Split surrogate pairs conservatively consume
extra admission credit while retaining their exact combined string. Closed
payloads leave the normalizer's active map; raw stream limits remain independent.

## Durable receipt

The generation consumer writes a version-1 JSON RawObject, together with its
canonical ProviderArtifact reference, through one existing atomic blob/record
checkpoint. Its kind is `quixi.provider.anthropic-thinking-block`, with locator
`block/<index>`. No canonical schema or migration changes are needed.

The receipt contains:

- `version`, `protocol`, `generationId`, `outputMessageId`, `responseId`;
- requested `model`, `returnedModel`, and provider block `index`;
- one-based `source.startRecord` and `source.endRecord`, plus the raw segment
  count and byte length durably retained through that checkpoint;
- the complete `block` object, containing either thinking/text/signature or
  redacted data according to the provider contract.

The consumer checks protocol, response/raw-source presence, index uniqueness,
record range and independent size limits. Lost replies use existing canonical
operation reconciliation before restaging, preventing duplicate receipts.
The receipt is a derived assembly of provider values, not the original JSON
serialization or proof that a provider signature is cryptographically valid.
Original raw segments remain authoritative and independently referenced.

## Remaining continuation contract

No new receipt is automatically dispatched. ReasoningMetadata and unsupported
artifacts still receive explicit compatibility refusals. Next, define and
implement provenance-bound reconstruction and request mapping: verify the
receipt against its generation and retained source, maintain block/semantic
ordering, bind the supported model/profile, and make inspection, counting,
sending and regeneration agree. Old streams without receipts need a bounded
reconstruction path or an explicit missing-evidence refusal. Imported or edited
summaries must never become invented signed blocks. Review and qualify thinking
parameters, tool-turn constraints, archived regeneration and cross-provider
refusals before enabling the supported continuation path.

[Validation](../validation/reasoning-block-capture.md) records this prerequisite's
unit, browser, native and archive evidence separately from that remaining work.
