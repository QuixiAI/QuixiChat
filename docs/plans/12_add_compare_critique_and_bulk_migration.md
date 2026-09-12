# 12 — Add compare, critique, and bulk migration

**Status:** In progress — design fixed in [ADR 0042](../decisions/0042-compare-critique-bulk-migration.md); bulk portability analysis, compare and critique implemented and proven; the reviewed migration remains open

**Workstream:** Product workflows — multiple generations and portability

**Depends on:** [08](./08_build_chat_and_library_ui.md), [10](./10_add_routing_and_provider_switching.md)

## Outcome

Let users compare alternative model attempts, request critiques, and assess or migrate groups of conversations while preserving every original answer.

## Product references

- [18. Generation](../product.md#18-generation)
- [20. Branching](../product.md#20-branching)
- [22. Thread events](../product.md#22-thread-events)
- [29. Core chat experience](../product.md#29-core-chat-experience)
- [36. Compatibility Inspector](../product.md#36-compatibility-inspector)
- [37. Portability status](../product.md#37-portability-status)
- [38. Context compaction](../product.md#38-context-compaction)
- [39. Compare mode](../product.md#39-compare-mode)
- [40. Critique mode](../product.md#40-critique-mode)
- [41. Bulk migration](../product.md#41-bulk-migration)

## Tasks

- [x] Implement compare requests that create separate Generation attempts for selected models from the same canonical prompt/path. `compare` commits the user turn once with a `Compare` event naming each candidate's pre-allocated generation and output, then runs one coordinated attempt per candidate concurrently without moving the selection ([validation](../validation/compare.md)).
- [x] Build comparison views with independent streaming/status, usage/cost metadata, candidate selection, and continuation from any alternative. The Compared answers section under the turn shows each candidate's live status, tokens and estimated cost with Select this answer; the selection and the view persist from the records after a reload and the next turn continues from the chosen answer ([validation](../validation/compare.md)).
- [x] Implement critique as a new generation with an explicit reference to the reviewed answer; never overwrite the original generation. `critique` starts an ordinary attempt whose parent is the reviewed answer's parent turn, with a `Critique` event in the same commit naming the reviewed message and generation; the proof checks the reviewed message and parts are byte-equal before and after ([validation](../validation/compare.md)).
- [x] Implement paginated bulk portability analysis with counts and inspectable reasons for fully portable, transformed, provider-dependent, and blocked threads. The Portability section analyses every library conversation's selected branch in 32-conversation pages against every configured target through the same reports the open conversation shows, with counts per outcome, per-conversation reasons, an outcome filter, 32-row pages and a way to open each conversation ([ADR 0042](../decisions/0042-compare-critique-bulk-migration.md), [validation](../validation/bulk-portability.md)).
- [ ] Reuse the compatibility inspector and context-compaction choices for bulk operations. Review transformations before committing routing or continuation changes.
- [ ] Bound concurrent provider work and bulk storage reads, support cancellation/retry, and preserve successful independent results when another attempt fails.
- [ ] Persist selection, critique relationships, migration events, and relevant routing changes through the canonical storage operations.

## Deliverables and interfaces

- Compare and critique UI/workflows using the existing Generation model.
- Bulk migration reports and bounded operation progress/retry behavior.

## Acceptance criteria

- [x] Failure or cancellation of one compared model does not discard other candidates. Attempts run independently; the proof fails the Anthropic candidate mid-stream while the OpenAI candidate completes and stays selectable, with both attempts and their sealed outputs retained ([validation](../validation/compare.md)).
- [x] Users can select and branch from any retained answer after reopening the thread. After a reload the compare view is rebuilt from the Compare event and the generation records, the chosen answer is marked, the other stays selectable, and a new turn continues from the selection ([validation](../validation/compare.md)).
- [ ] Critiques and bulk transformations retain their source relationships and original history.
- [x] Bulk processing remains paginated and reports per-thread blocked/failed outcomes. The analysis walks library pages one conversation at a time, can be stopped between conversations keeping what was analysed, records a per-conversation failed outcome with its reason (and a Retry) instead of stopping, and reports blocked conversations with the blocking parts named per target ([validation](../validation/bulk-portability.md): 3 controller tests, both engines in the shared-app proof).

## Boundaries and sequencing

This builds on live adapters and compatibility analysis. It does not create autonomous agents or tool-execution workflows beyond the conversation capabilities in the product spec.

[Back to the roadmap](./README.md)
