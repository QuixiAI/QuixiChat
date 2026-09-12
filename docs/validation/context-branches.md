# Explicit fresh context branches

This records the branch iteration’s captured source revision. The subsequent
[cost-limit slice](request-cost-limits.md) reruns all shared-application checks.

2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. Product §38 / plan 10,
[ADR 0021](../decisions/0021-fresh-context-branches.md). No paid provider call or
private history was used.

## Behavior

“Review fresh branch” explains that the same conversation keeps its current
system prompt, routing profile, attachment exclusions, unsent draft and staged
images. Previous messages and the applied summary are excluded from the new
branch's requests. A separate checkbox enables Start; Cancel writes nothing.
Review is discarded when its selected scope changes. Starting sends no provider
request and creates no placeholder message. The next explicit Send creates a
root user message; Show starting branches reopens earlier history.

One expected-revision transaction creates an immutable context snapshot, selects
an empty path and records `ContextCompaction/start_branch` anchored to the old
leaf and context. If necessary it clears the applied summary and records the
matching `clear_summary` event in the same batch. Both context and branch
selection advance the existing thread revision. It preserves original messages,
parts, contexts, attempts, summary provenance, exclusions and routing settings.
Schema 12 and archive protocol 4 already represent these records and stay unchanged.

The worker checks the pre-batch source, exact mutation set, context clone and
audit details. Stale or empty selections, unsealed/hidden/summary output sources,
live ordinary or summary producers, unrelated mutations and staged blob writes
refuse. An uncertain reply retains the exact original transaction for the
existing Check pending change action. Reconciliation reloads the branch value
recorded by the batch, including null, instead of the stale displayed leaf.
Prompt counting refuses while a canonical change is pending or busy; a branch,
revision or context change during preparation prevents late provider dispatch.
The empty-branch notice survives reopening; the summary-clear event describes
clearing for a fresh branch without claiming full history is sent.

## Verification

[Unit/build report](results/context-branches-unit-macos.json):

| Command | Result |
| --- | --- |
| `npm run test:storage:canonical` | 54 passed |
| `npm run test:app:summaries` | 21 passed, including 3 fresh-branch controller tests |
| `npm run test:app:switching` | 29 passed |
| `npm run test:storage:archives` | 13 Node tests and Chromium/WebKit snapshot proofs passed |
| `npm run check` | SQLite verification, typecheck and both frontend builds passed |

The 104 affected Node tests plus 13 archive tests include pre-commit rollback,
unchanged records/operations, exact transaction and operation replay, SQL reopen,
old-path reselection, summary clearing, malformed/stale/destructive batch refusal
and live producer races. The actual library-controller tests cover archive
selection changes, pending global state and exact-batch recovery to null without
reading historical message parts. Request-path tests also prove no count dispatch
for busy/pending state or a scope change during context preparation, and no
ancestor reads when counting an empty branch with the summary cleared.

The [portable archive report](../../packages/storage/tests/archives/results/snapshot-browser.json)
checks the same-thread fresh branch after a reviewed summary in real Chromium and
WebKit: exact canonical records, edges, sync journal and an explicitly null active
selection survive portable restore. Its captured source hashes match this slice.

[Shared application report](results/context-branches-app-macos.json): **37 groups
in each of actual Chromium and Playwright WebKit**, through the production app,
host/adapters, Storage Worker and OPFS archive with controlled loopback HTTP.
The new scenario starts with an applied reviewed summary, routing fallback and
an excluded image. Review/cancel preserve the context/event counts and selection;
starting through a lost durable reply produces exactly one context and the two
required events, with unchanged original messages and parts. The draft and staged
image survive. Token counting, the failed primary and its fallback carry the
system prompt and new draft, without previous messages, image bytes, exclusion
markers or the old summary. The next send has a null parent. Original roots remain
selectable. A second fresh branch's empty selection/context, both audit messages
and old-root navigation survive a full browser-process restart without provider
credentials. The narrow layout fits the viewport.

Visual review: [Chromium review](results/context-branches-chromium-review.png),
[Chromium mobile](results/context-branches-chromium-mobile.png),
[WebKit review](results/context-branches-webkit-review.png),
[WebKit mobile](results/context-branches-webkit-mobile.png).

The retained summary reports describe their earlier captured source revision;
this new application report reruns all prior summary and compaction checks against
the final branch implementation. Initial browser setup failures (a collapsed
system-prompt editor and an already-closed summary review) were corrected in the
test setup. The final captures include the checkbox alignment correction found
in visual review.

## Limits and remaining work

All provider traffic in the application proof uses synthetic loopback responses.
This does not qualify actual summary fidelity, installed Safari, native Tauri or
other operating systems. Ten authored summary-quality fixtures still have zero
scored model runs; qualification requires recorded requests/outputs, critical-fact
and unsupported-claim grading, repeated compaction and downstream questions using
a redistributable local model or an explicitly authorized provider run. Request-cost enforcement is implemented in the subsequent cost-limit slice;
region constraints remain open in plan 10.
This slice does not complete the plan or the broader implementation goal.
