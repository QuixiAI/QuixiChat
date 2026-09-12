# ADR 0032 — Provenance-bound reasoning continuation and manual thinking

Date: 2026-09-11. Status: accepted. Completes the request side that
[ADR 0031](./0031-complete-thinking-block-capture.md) left open for plan 06.

## Contract review

Sources fetched on 2026-09-11: the [extended-thinking guide](https://platform.claude.com/docs/en/build-with-claude/extended-thinking),
the [thinking overview](https://platform.claude.com/docs/en/build-with-claude/thinking)
and the [count-tokens reference](https://platform.claude.com/docs/en/api/messages-count-tokens).

- Claude Haiku 4.5 supports only manual thinking: `thinking: {type: "enabled",
  budget_tokens: N}` with N at least 1,024 and below `max_tokens`. Adaptive
  thinking returns a 400 on this model, and interleaved thinking is ignored.
- While thinking is enabled on this model, `temperature` and `top_k` are
  incompatible and `top_p` is accepted only between 0.95 and 1. Response
  prefill and forced tool choice are incompatible.
- Thinking and redacted blocks must be passed back complete and unmodified,
  in their original sequence, before other blocks of their assistant message.
  They are strictly required only inside a tool-use loop; outside it, prior
  turns' thinking may be omitted. Haiku 4.5 keeps only the latest turn's blocks
  and strips older ones itself. A block is readable only by the model that
  produced it or a newer one.
- The count endpoint accepts the same `thinking` configuration and the same
  message blocks as a generation.

## Decision

**Parameter.** The reviewed Anthropic catalog entry declares the exact
profile `anthropic-manual-haiku-4.5` and permits `thinkingBudgetTokens`. The
mapper emits `thinking.enabled` only under that profile and refuses by name a
budget below 1,024 or at or above the output limit, any temperature, and a
top-p outside 0.95–1. The composer shows a "Thinking budget" control only when
the selected model permits it, blocks sending on each constraint with the
reason, and keeps the draft. No other model or protocol accepts the parameter.

**Evidence.** A ReasoningMetadata marker is request content only through a
verified entry keyed by its part ID. The workflow loads the message's
`quixi.provider.anthropic-thinking-block` receipts through the storage
boundary, parses them against the version-1 contract and binds them to the
message: the receipts must name the message's generation and output message,
share one response identity and model, match the markers in count and kind,
ascend by provider index and record range, and each receipt's opening record
must equal the marker's `generation-stream/record/N` locator. Any disagreement
binds nothing for that message. Display summaries, imported markers and edited
copies never become blocks.

**Reconstruction.** A message without valid receipts is reconstructed from its
retained raw-stream segments through the same decoder and normalizer a live
generation uses, bounded at 8 MiB, and the rebuilt receipts must pass the same
binding. A stream that ends before its terminal marker, fails the protocol or
exceeds the bound yields no evidence.

**Shaping.** Every request path (inspection, portability, count, send,
regeneration and fallback) shapes the branch for its target before mapping:
a verified block stays only when the target is the producing model; a marker
that a tool result follows is always kept so the mapper refuses it by name
when it cannot be carried; every other unverifiable or foreign marker is
omitted and counted as a transformation the switch report, portability and
recorded switch name. This follows the contract's own rule that prior-turn
thinking is optional outside tool use, and never sends a block to a model
that cannot read it.

**Mapping.** Under the profile, verified blocks are carried first and in
original index order with exact values; wrong message, model, kind, order,
missing signature or size produce distinct refusal codes. The Chat Completions
profile has no input representation and refuses the markers. Receipts and
stream locators are evidence parts, listed under the response's source
records and never sent. Inspection, count, send and regeneration share one
mapper and one shaping function, so their bodies agree.

## Alternatives rejected

- Sending display summaries as thinking text: rejected by the contract and
  by ADR 0031.
- Blocking every conversation that once used thinking from continuing on
  another provider: rejected because the contract permits omission outside
  tool use and the omission is reviewable.
- Recording the thinking budget in the generation record: deferred; the
  request body is retained in the raw manifest and the composer setting is
  per attempt, like sampling parameters.

## Limits

Signature validity, live acceptance of continued blocks, thinking quality and
billing are not established by controlled fixtures; the loopback provider
enforces the documented shape only. Continuation across a tool loop is mapped
but unexercised because the shared chat does not invoke tools.
[Validation](../validation/reasoning-continuation.md) records the evidence.
