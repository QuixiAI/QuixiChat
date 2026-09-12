# ADR 0042: Compare, critique and bulk migration on the Generation model

**Status:** Accepted (design), 2026-09-12
**Plans:** [12](../plans/12_add_compare_critique_and_bulk_migration.md)
**Product:** §18 Generation, §20 Branching, §22 Thread events, §36 Compatibility Inspector, §37 Portability status, §39 Compare mode, §40 Critique mode, §41 Bulk migration
**Related:** [ADR 0017](./0017-provider-switch-inspection.md) (switch inspection), [ADR 0023](./0023-integrated-native-constrained-attempts.md) (routing)

## Context

Plan 12 adds three workflows over the existing canonical model. None of them
may create a new kind of history: compare answers are Generations, a critique
is a Generation that names what it reviewed, and bulk migration is an analysis
first and a reviewed routing change second. This ADR fixes how each maps onto
what exists so that no original answer is ever rewritten or discarded.

## Decision

1. **Compare = N attempts from one parent.** A compare request takes the
   composer's prompt and the selected models and starts one attempt per
   model through the existing coordinated generation path
   (`startCoordinatedGeneration`), each with its own `Generation`, output
   `Message` (sibling children of the same parent, so §20 branching already
   shows them) and event. Attempts are independent: one failure or
   cancellation leaves the others streaming and their outputs sealed. The
   only new canonical data is a `ThreadEvent` of type `Compare` on the
   parent that lists the attempt ids, so the set can be shown together and
   survives reopening. Selecting one is the existing `SetActiveBranch`;
   continuing from any alternative is ordinary sending on that branch.
2. **Critique = a Generation with a reference.** A critique request builds
   its prompt from the reviewed answer's parts (the request mapper's path,
   so transformations are the inspector's) and starts one attempt whose
   `Generation.parameters` carry `critiqueOf: { generationId, messageId }`
   and whose creating event is `Critique` naming the same. The reviewed
   generation is untouched; the critique's output is a sibling branch of
   the reviewed answer's parent. Its origin is visible from either side.
3. **Bulk migration = paginated analysis, then reviewed changes.** The
   analysis walks `listLibrary` pages (32 conversations, active then
   archived), reads each conversation's selected branch through the chat
   workflow's path context, analyses it with every configured target's
   `analyze` report exactly as the open conversation's portability does,
   and classifies it with `describePortability`. It is read-only, one
   conversation at a time, cancellable between conversations, retries a
   conversation while a generation holds the workflow busy, records a
   per-conversation `failed` outcome with the reason instead of stopping,
   and keeps at most 10,000 rows in memory while counts cover everything.
   Migration itself (a routing-profile change for a reviewed set) reuses
   the switch inspection and the compaction choices per conversation and
   commits `SetRoutingProfile` per conversation with a `Migration` event;
   it never touches messages, generations or parts.
4. **Bounds.** Compare runs at most four attempts at once; bulk analysis
   reads one conversation at a time with the request path's existing byte
   and message limits; both stop between units on cancellation.

## Consequences

- No new tables or record kinds: events and generation parameters carry the
  relationships, so export, restore, search and the Doctor audit already
  cover them.
- The library's portability counts (plan 10's deferred item) come from the
  same reports the open conversation shows, so the two never disagree.
- Migration events make a bulk routing change auditable per conversation
  and reversible by another reviewed change.
