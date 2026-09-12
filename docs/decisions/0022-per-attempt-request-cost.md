# 0022 — Enforce estimated request cost before each attempt

2026-09-10. Implemented and verified in [cost acceptance](../validation/request-cost-limits.md).
Product §34 calls for a maximum request cost. The former `maxRequestCost` field
only represented input cost and silently skipped its check when no count existed.
The fallback workflow did not evaluate that limit. Neither behavior is sufficient.

## Policy and compatibility

Preserve `maxRequestCost` as an independent estimated-input USD limit. Add
`maxEstimatedRequestCost` for input plus the selected maximum output, per attempt.
Both are nonnegative decimal strings, at most nine digits on either side of the
decimal point. Zero is a real limit, not an absent setting. The UI names both
limits and explains that each primary, fallback, regeneration and summary request
is checked separately. This is not a cumulative retry allowance or an invoice
ceiling; it enforces a preflight estimate using the reviewed pricing snapshot.

Profiles carrying the new field use version 4, with or without an explicit primary.
Earlier shapes preserve their old version when no new limit exists. A new cap in
a version-2/3 profile, or invalid/unknown requirements, is refused rather than
silently discarded. An alias snapshot uses version 4 when its new cap is present;
its version-1 local registry keeps the existing closed-field validation. Older
profile parsers refuse version 4, and older registry validators refuse the new
field rather than overwriting it. Canonical routing profiles remain opaque JSON
to storage. No new canonical record, table or archive interpretation is needed;
schema 12 and archive protocol 4 stay unchanged. Portable validation covers the
exact new profile together with the prior compaction records.

## Assessment and request binding

A pure shared assessment uses BigInt decimal arithmetic. Multiply input tokens
by the standard input rate and output-token limit by the output rate, divide by
one million, and round the combined amount upward to a nano-USD once. The input
amount is rounded separately for its independent legacy limit. Compare these
amounts exactly with the limits. Do not assume cache discounts. Missing/non-USD
or malformed prices, invalid output/count/window values, or missing input evidence
refuse a capped request. Uncapped requests need no pricing evidence.

Without a matching count, budget the full declared context window as input,
in addition to the selected maximum output. This deliberately conservative
bound does not require a provider call or a heuristic tokenizer. If it exceeds
the configured limit, the user can count explicitly for a tighter estimate or
review the limit. Counts are estimates, so this remains an estimated-cost policy.
There is no silent count request or automatic limit increase.

The chat controller retains at most 16 successful counts in memory, keyed by
adapter identity, model and SHA-256 of the exact prepared generation body. It
retains neither input text nor attachment bytes in that cache. Only explicit
counts taken under a configured cap are cached. A changed body (draft, history,
system prompt, images, parameters or output cap), model or adapter cannot reuse
one. Fresh canonical message/part IDs do not invalidate identical wire content.
Late counts after cancellation, disposal or scope changes do not authorize work.
The cache is cleared on disposal and is not stored or exported.

Routing shows the same assessment and refuses an unassessed cap. The workflow
rechecks the canonical profile and exact request before publishing the user turn
or starting regeneration. A fallback assesses its own model/body, using its own
matching count or context bound; a count from the failed provider is never reused.
It obeys both the originating and current cost requirements, and records the cost
basis in the existing fallback event's reason. Summary generation uses its
independently reviewed prepared input/count and refuses before raw-input staging
or generation writes. Counting remains available while generation is blocked.

## Dated source review

The following official pages were searched and opened on 2026-09-10. Existing
catalog values were confirmed; this slice does not silently change model choices,
rates, endpoint mapping or provider credentials.

- [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini):
  1,047,576-token context, 32,768 maximum output, standard rates $0.40 input and
  $1.60 output per million tokens. The model has no reasoning step.
- [Chat Completions create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create):
  `max_completion_tokens` limits completion tokens, including reasoning where
  applicable. The current adapter already sends this field.
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) and
  [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview):
  standard input/output rates $1/$5 per million; the current catalog uses the
  200k context and 64k maximum output. Cache, regional and other pricing modes
  are not assumed for these existing request profiles.
- [Claude token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting):
  counts are model-specific estimates and may differ slightly from generation
  usage; counting does not apply caching logic. Count endpoints are invoked only
  by an explicit user action. The current OpenAI-compatible adapter reports
  counting unavailable; this is an implementation limit, not a claim about every
  OpenAI API or endpoint.

Region constraints, actual summary-fidelity qualification and broader platform
release gates remain separate requirements. Paid-provider invoice reconciliation
is not established by the synthetic request proofs.
