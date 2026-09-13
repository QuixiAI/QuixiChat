# ADR 0043: Materialized library activity

Date: 2026-09-13. Status: accepted. Plans [08](../plans/08_build_chat_and_history_ui.md),
[24](../plans/24_validate_scale_and_release_hosts.md); product §98 (100k
threads, 1M+ messages without archive-wide materialization).

## Context

The library view (`listLibrary`) orders conversations by pinned state and
latest activity, filters by archived state and title, and pages with a
keyset cursor. Until schema 12 it computed every thread's activity with a
correlated subquery over the message recency index, inside a query over
every `threadStates` row, sorted that set and took one row per statement
(a `LIMIT 1` loop per page item). The cost of one page was therefore
`items × threads` recency lookups plus `items` sorts of `threads` rows. The
1M-message stress run measured it: 25.4 s for the first 64-item page at
100,000 conversations in WebKit, 515 s for twenty pages
([storage-stress.md](../validation/storage-stress.md)).

## Decision

1. **One materialized row per thread**, table `quixi_library_activity`
   (schema 13, `packages/storage/migrations/library-activity.ts`): `created`
   (the thread's creation time), `message_activity` (the latest message
   recency, or null), `pinned`, `archived`, `deleted` and a stored generated
   `activity = coalesce(message_activity, created)`, indexed as
   `(archived, deleted, pinned DESC, activity DESC, thread_id)`, which is
   exactly the library order.
2. **Kept by triggers on canonical rows**, never by application code:
   `threads` insert sets `created`; `messages` insert raises
   `message_activity` to the message's recency; `threadStates` insert and
   payload update copy `pinned`/`archived`; a whole-thread tombstone sets
   `deleted`. Canonical rows are never deleted, so no delete trigger exists.
   The migration backfills the table from the existing records, so an
   upgraded archive reads the same as a freshly written one.
3. **One statement per page.** The view walks the index from the cursor,
   joins each candidate's thread state for title, tags and revision, and
   fetches `maxItems + 1` rows; the byte budget and cursor rules are
   unchanged, as is the `CONFLICT` refusal when the archive changed under a
   cursor.
4. **Older archives keep the per-item scan.** Retained read-only archives
   at schema 8–12 are read through the previous query; the view checks
   once per connection whether the table exists.

## Consequences

- The materialized row is derived data that lives in the canonical
  database because it is maintained transactionally with the rows it
  summarizes; it holds no content (times, flags and the thread id only)
  and is rebuilt by the migration, not by a repair action.
- Semantics are the previous query's, with two deliberate clarifications:
  a state without `pinned` or `archived` counts as not pinned and not
  archived (validation requires both, so no stored archive differs), and a
  message's recency is `createdAt` falling back to `recordedAt`, as before.
- Every canonical insert of a thread, message or state pays one indexed
  upsert; the 1M-message seed measures that cost in the stress run.
- Evidence: `packages/storage/tests/canonical/views.test.ts` compares the
  per-item scan and the index walk over the same archive before and after
  the 13 upgrade and after pins, archive changes, new messages, a
  whole-thread deletion and title filters; the schema-upgrade test now
  covers ceilings 10, 11 and 12. The stress run records the page timings.
