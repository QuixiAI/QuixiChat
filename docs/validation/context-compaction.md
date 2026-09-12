# Reviewed attachment context exclusions

2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. This delivers the attachment
exclusion portion of product §38 / plan 10 under [ADR 0019](../decisions/0019-reviewed-context-compaction.md).
This report retains the schema-11 attachment-exclusion checkpoint. The subsequent
[summary increment](context-summaries.md) implements generation/review/apply/clear
under schema 12/protocol 4 and adds failed-primary/fallback evidence. Actual model
fidelity and an explicit compaction branch action remain open.

## Behavior

The composer reviews at most 64 attachment occurrences from the selected branch
and any existing exclusions outside it. Discovery reads metadata only, supports
cancellation, and refuses partial discovery beyond 2,047 messages, 4,096 requests
or 8 MiB of returned metadata. Applying requires an explicit review tied to the
thread revision, context snapshot and leaf. Cancel does not write or send.
Applying or clearing creates an immutable ContextSnapshot and ContextCompaction
event with both journal entries in one conditional transaction. Unknown outcomes
use the existing pending canonical transaction reconciliation path.

The shared effective-context builder substitutes the exact text
`[Attachment omitted by your context choice.]` before any excluded attachment's
byte read. Counting, inspection, portability, sending and regeneration use that
builder; automatic fallback reuses its effective input. Filenames, descriptions,
ids and bytes from that occurrence are excluded. Original parts, attachments and
snapshots remain unchanged; another occurrence or newly attached file is separate.
Exclusions survive reload and portable restore. Changing context invalidates
prior switch review and token counts; late counts require the captured revision
and context to remain current. Savings are never guessed: counting stays explicit.

Schema 11 adds a compatibility ledger gate with no new data table. Schema 10
upgrades without changing canonical records. An older migration ceiling refuses
11. Archive protocol 3 also fences old followers: they cannot forward requests to
a newer owner on protocol 2. The shared owner lock remains unchanged. The actual
frozen schema-8 worker waits, then refuses the newer ledger without mutation.

## Verification

[Unit and build report](results/context-compaction-unit-macos.json):

| Command | Result |
| --- | --- |
| `npm run test:core` | 52 passed |
| `npm run test:storage:canonical` | 42 passed |
| `npm run test:app:preferences` | 7 passed |
| `npm run test:app:switching` | 21 passed |
| `npm run test:app:attachments` | 9 passed |
| `npm run test:storage:archives` | 13 Node tests plus both browser proofs passed |
| `npm run check` | SQLite verification, typecheck and both frontend builds passed |

The 144 Node tests include strict policy shape/reference validation, immutable
originals, stale/duplicate commit behavior, rollback with neither partial context
nor event, close/reopen, schema upgrade/refusal, discovery bounds and cancellation.

[Shared app proof](results/shared-app-macos-26.6.2.json): **33 groups each in actual
Chromium and Playwright WebKit**. The new group checks review/cancel, immutable
snapshot/event, counting and sending a verified PNG as the same marker, clearing
and reapplying, regenerating with the marker, unchanged original parts, and a
browser-process restart retaining the selected exclusions. Existing alias,
preferences, switching, failed/partial/stopped fallback and export groups pass.
The [Chromium](results/context-compaction-chromium-review.png) and
[WebKit](results/context-compaction-webkit-review.png) review screenshots were
visually inspected, as was the resulting conversation.

[Archive proof](results/context-compaction-archives-macos.json): both browsers
pass. A separate schema-11 fixture is created after the schema-8 upgrade proof,
so a new policy never masquerades as an old archive. Its real portable export,
bounded transfer, restore validation and read-only candidate comparison preserve
all canonical JSON, reference edges and sync operations exactly, with original
blob integrity validated. The exclusion snapshot, event and attachment all remain.

[Protocol proof](results/context-compaction-protocol-macos.json): **six groups
per engine**. Actual owner/follower writes, strict protocol-3 envelopes, silence
on the protocol-2 channel, rejected old versions and frozen old-worker ledger
refusal pass. The [first failed run](results/context-compaction-protocol-first-failed.json)
found unexpected pre-existing synthetic WebKit records. The harness now clears
only its two synthetic default stores in its disposable proof profile before
opening any worker; expected operation counts remain unchanged.

[Activation proof](results/context-compaction-activation-macos.json): **nine groups
per engine**, including real managed activation and current schema-11 diagnostics.
[Public extraction regression](results/context-compaction-extraction-macos.json):
**seven groups per engine**. [Retained extraction recovery](results/context-compaction-retained-macos.json):
**five groups per engine**. Its [first run](results/context-compaction-retained-first-failed.json)
correctly refused a test ledger with version 10 removed but 11 retained. The
pre-10 fixture now removes all versions >=10 to model the intended contiguous
schema-9 prefix; unknown outcomes and unchanged source bytes pass again.

## Limits and next work

No paid provider or private data was used. Browser evidence does not qualify
installed Safari, the native host or other operating systems. The existing large
frontend bundle warning remains a release gate. A combined exclusion plus
failed-primary fallback browser scenario has not been captured: the effective
input reuse is code-reviewed and existing fallback scenarios pass separately.
Lost canonical apply replies likewise use the existing recovery path; this new
UI scenario has not independently injected such a reply loss.

Plan 10 remains underway. Next, decide the bounded older-prefix/summary schema,
preserve generating attempt and source provenance, and verify summary quality
before exposing proposal/review/application. Explicit compaction branching and
its event still require implementation. Region metadata, request-cost enforcement
before counting and broader reload/inspection acceptance also remain open.
