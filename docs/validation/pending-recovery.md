# Pending-change recovery across navigation and search

This increment addresses the source-established path where opening a conversation
or completing lexical search cleared the ordinary error containing Check pending
change, while the original mutation still had an unknown outcome.

## Behavior

The library snapshot now carries a separate pending-recovery record with the
originating conversation identity/title when unambiguous, its status message,
and whether a check is running. It appears only after an unknown outcome, not
while an ordinary initial write is still in flight. Dismissible errors, search
results and conversation navigation do not own this record.

The application exposes a dedicated Pending change recovery region within the
stable Workspace status focus boundary. It names the original conversation and
keeps Check pending change available after ordinary errors are dismissed. A
running check disables that button and announces its phase. A refused check
keeps the outcome explicitly unknown and allows another attempt.

Reconciliation reuses the cloned, frozen original mutation batch and its exact
transaction/operation IDs. Concurrent calls share one retry. Successful receipt
clears the recovery; failure to refresh a view afterwards is an ordinary read
error and does not turn an acknowledged write back into an unknown outcome.
Explicit navigation is tracked separately from background refresh so a held
reply or library refresh cannot replace a newer selected conversation or leaf.
Existing previous-archive reconciliation remains bound to the original operation
IDs and does not retarget a write to the selected replacement archive.

## Qualification

Qualification passes **60 groups in Chromium and 60 in Playwright WebKit**,
**127 unit tests** (22 library, 31 compaction, 74 switching), and `npm run check`
on macOS 26.6.2 / arm64 / Node 22.23.1. The
[application report](results/pending-recovery-app-macos.json) and
[aggregate record](results/pending-recovery-checks-macos.json) retain 95 matching
source hashes and 10 artifacts, including both recovery screenshots, which were
visually inspected.

The production-browser scenario starts after a real summary commit whose reply is deliberately lost. It captures the already
committed records, dismisses the ordinary error, opens another conversation and
runs lexical search, refuses one check before dispatch, then holds the exact
retry while the user navigates again. The selected conversation and focus
remain, all captured canonical records/sync operations match exactly, and
provider/count traffic is unchanged. It returns to the source conversation
for the existing summary/request/archive/restart checks.

The [first browser attempt](results/attempts/pending-recovery-01/app-browser.json)
caught a fixture timing error: the baseline capture began before the original
commit reached its unknown-outcome state. The capture now waits for the dedicated
recovery region, which appears only after that write finishes. Exact full-record
and sync comparisons remain required.

Controller regressions cover the same separation, immutable intent, concurrent
checks, failed checks, newer same-thread leaf selection, navigation during reply
and list-refresh waits, previous-archive outcomes, ordinary writes, post-receipt
read failure and disposal.

These are live-session recovery checks with disposable synthetic archives and
loopback providers. They do not establish actual screen-reader speech, installed
Safari/native-host accessibility, or a new durable client-side pending-intent
journal across application reloads. Existing storage/archive recovery evidence
retains its own stated scope.
