# Bulk portability analysis and reviewed migration

Plan [12](../plans/12_add_compare_critique_and_bulk_migration.md), product
§37/§41, [ADR 0042](../decisions/0042-compare-critique-bulk-migration.md).
Last run 2026-09-12 on macOS 25.6.0 (arm64), Node v22.23.1, Playwright
Chromium and WebKit.

## What is proven

**Controller (Node)** — `npm run test:app:migration`, 3 tests,
`packages/app/tests/migration/controller.test.ts`:

- the library is walked page by page (32 conversations; active, then
  archived) one conversation at a time, with counts per outcome and rows
  carrying the label, summary, per-target reasons, target and sendable
  counts; a `null` inspection is "No messages yet", a thrown read is a
  per-conversation "Analysis failed" with its reason, and a workflow that
  reports busy is retried;
- stopping keeps what was analysed; Retry re-analyses one failed
  conversation in place and moves its count;
- filter and page are view state; disposal stops a running analysis.

**Application (Chromium and WebKit)** — the shared-app proof
(`npm run test:app:browser`, 96 checks per engine,
[retained](results/shared-app-macos-26.6.2.json)) opens the Portability
section after the plan 10 scenarios, analyses the whole library and checks:
the total equals the library's conversation count read page by page through
the storage client, the outcome counts sum to the total with zero failed,
the seeded "Portability thread" is listed as portable with its per-target
reasons ("Anthropic · Claude Haiku 4.5: carries all …") behind a Reasons
toggle, the first page holds at most 32 rows, the Blocked filter narrows the
list to the blocked count, and Open conversation opens the conversation.

Last run: 4 library conversations in both engines: 2 fully portable, 1 portable with transformations, 1 provider-dependent, 0 blocked, 0 without messages, 0 failed.

## Reviewed migration (product §41, ADR 0042)

Every analysed conversation carries per-target outcomes (sendable,
transformations, blocking parts and constraints) and its current primary.
Choosing a target marks each conversation eligible (the target can carry it
and is not already its primary), ineligible, or not analysed against it;
"Select all eligible" or per-conversation ticks build the set; a review
lists each conversation with what it would carry; confirming commits, per
conversation and against its current revision, one `SetRoutingProfile`
naming the target as the primary and one `Migration` event (`from`, `to`,
transformations, `source: bulk-portability`). Blocked, unchanged and failed
conversations are reported per conversation and never stop the rest;
"Stop" halts between conversations. No message, generation, part or
attachment is read for writing. A migrated conversation opens on the
target connection with its Migration event listed; another reviewed
migration can route it elsewhere again.

**Controller (Node)** — the fourth test of `npm run test:app:migration`:
eligibility per target (a blocked target and an already-primary target are
not eligible), no commit without a review, one `SetRoutingProfile` and one
`Migration` event per conversation pinned to its revision with `from` null
or the previous primary, a blocked conversation and a failed commit kept
as their own outcomes, and a migrated conversation not eligible again.

**Application (Chromium and WebKit)** — the shared-app proof (100
checks per engine): every eligible conversation is routed to GPT-4.1 mini
after a review that lists each one; "Keep the current routing" leaves the
thread states byte-equal; confirming adds exactly one Migration event and
one primary change per eligible conversation, leaves messages untouched and
ineligible conversations alone, marks the rows Migrated, and a migrated
conversation opens on the target connection with its event line.

Last migration run: 4 conversations (Comet notebook, Keyboard notebook, Portability thread, Image thread) routed to openai|gpt-4.1-mini-2025-04-14 and back to anthropic|claude-haiku-4-5-20251001 in both engines, one Migration event per conversation per migration.

## Limits

- The analysis reads each conversation's selected branch through the chat
  workflow's request path, including attachment bytes up to the request
  bound, so it costs roughly one request preparation per conversation; it
  yields between conversations and can be stopped between them.
- Rows are kept for the first 10,000 conversations; counts cover all.
- While a generation is in progress the workflow is busy; the analysis
  retries that conversation for up to ten seconds and then records it as
  failed with that reason, for Retry.
- Context-compaction choices stay per conversation in the conversation view;
  the migration review shows the request transformations the inspector
  reports and does not change compaction.
