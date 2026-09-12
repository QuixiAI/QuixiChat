# 12 — Add compare, critique, and bulk migration

**Status:** Planned

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

- [ ] Implement compare requests that create separate Generation attempts for selected models from the same canonical prompt/path.
- [ ] Build comparison views with independent streaming/status, usage/cost metadata, candidate selection, and continuation from any alternative.
- [ ] Implement critique as a new generation with an explicit reference to the reviewed answer; never overwrite the original generation.
- [ ] Implement paginated bulk portability analysis with counts and inspectable reasons for fully portable, transformed, provider-dependent, and blocked threads.
- [ ] Reuse the compatibility inspector and context-compaction choices for bulk operations. Review transformations before committing routing or continuation changes.
- [ ] Bound concurrent provider work and bulk storage reads, support cancellation/retry, and preserve successful independent results when another attempt fails.
- [ ] Persist selection, critique relationships, migration events, and relevant routing changes through the canonical storage operations.

## Deliverables and interfaces

- Compare and critique UI/workflows using the existing Generation model.
- Bulk migration reports and bounded operation progress/retry behavior.

## Acceptance criteria

- [ ] Failure or cancellation of one compared model does not discard other candidates.
- [ ] Users can select and branch from any retained answer after reopening the thread.
- [ ] Critiques and bulk transformations retain their source relationships and original history.
- [ ] Bulk processing remains paginated and reports per-thread blocked/failed outcomes.

## Boundaries and sequencing

This builds on live adapters and compatibility analysis. It does not create autonomous agents or tool-execution workflows beyond the conversation capabilities in the product spec.

[Back to the roadmap](./README.md)
