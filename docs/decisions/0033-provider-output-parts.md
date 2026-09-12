# ADR 0033 — Provider-specific output parts in later requests

Date: 2026-09-11. Status: accepted. Closes plan 06's "provider-specific
unsupported parts" content profile.

## Problem

Assistant responses retain Citation parts, StructuredData values (including
the Chat Completions refusal marker) and raw-only ProviderArtifact parts for
output blocks the reviewed profiles do not model (unknown Anthropic block
types, Chat Completions delta fields such as `reasoning_content`). The mapper
refused all of them with one generic `content_mapping` reason, so any turn that
carried a citation could not be continued on any target.

## Contract review

Read on 2026-09-11: the [Anthropic Messages input contract](https://platform.claude.com/docs/en/api/messages/create)
accepts `citations` on an input text block only with the cited document
blocks present and rejects unknown block types; the
[Chat Completions assistant message parameter](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts)
has `content`, `refusal`, `name`, `audio`, `tool_calls` and no `annotations`.
A canonical Citation carries a URL, label and source part only, never the
cited document, so no provider can accept it as a citation.

## Decision

The workflow transforms these parts before mapping, target-independently,
following product §3.3 ("citations transformed", "provider-specific artifacts
degraded"), and counts each transformation for the switch report, portability
and the recorded switch:

- A Citation becomes a Text part `[Source: label — url]` with the same part
  identity; a citation naming nothing is omitted.
- A StructuredData value whose object `type` starts with `provider_` (the
  refusal marker, whose text is already a Text part) is omitted; any other
  value is sent as its JSON text within 64 KiB, otherwise left for refusal.
- A ProviderArtifact located in this generation's own stream
  (`generation-stream/…`) is omitted; the original remains in history and
  under the response's source records.
- Import-derived artifacts keep their source locators and stay in the request
  for the mapper's refusal, so an imported branch with unsupported content is
  still blocked rather than silently reduced.

The mapper names each remaining case: `citation_unsupported`,
`structured_data_unsupported`, `provider_artifact_unsupported`.

## Alternatives rejected

- Mapping Citation to an Anthropic `citations` input: impossible without the
  cited documents; inventing document blocks would be fabrication.
- Moving refusal text into the Chat Completions `refusal` field: the marker
  and text are separate parts without a link; the text already travels as
  content, and the marker is metadata.
- Keeping the generic refusal: blocks every cited conversation from
  continuing, against product §3.3.

[Validation](../validation/provider-output-parts.md) records the evidence.
