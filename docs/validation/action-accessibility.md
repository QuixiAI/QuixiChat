# Action context, workspace recovery and compatibility announcements

This increment extends the production shared-application proof for plans 08/13
and product section 93. It uses disposable synthetic archives and loopback
provider fixtures through the production host, adapters and storage worker.

The later [pending-recovery increment](pending-recovery.md) supersedes this
snapshot's dismissal policy: ordinary errors can be dismissed independently,
while a dedicated recovery region survives navigation and search. The evidence
below describes the earlier qualified source snapshot.

## Behavior

Message articles expose their speaker and position on the current page. Repeated
quote, part-navigation, sibling, continuation, regeneration and edit actions
include that context after their visible label. The label stays bounded and does
not change with streamed token text. Page-relative positions avoid presenting a
windowed history as if it were loaded in full.

Conversation fallback removal names the numbered provider/model target. The
routing section has a stable visible heading for focus recovery. Global notices
have their own stable Workspace status boundary: its accessible heading is
initially visually hidden; once focused, it remains visible with the ordinary
focus outline. Retaining its layout space prevents pointer targets from moving
between pointer-down and pointer-up when focus leaves the heading.
Removing a focused reconciliation or Dismiss control recovers there; completing
work after the user moves elsewhere leaves that new focus alone. No recovery
replays the action or changes its canonical mutation. Dismiss stays disabled
while an outcome is unknown, and the controller refuses to clear that error,
keeping the reconciliation action available. A known pre-commit refusal remains
dismissible and creates no history. Two controller regressions distinguish these
paths and verify that reconciliation replays the original transaction.

The Apply routing alias select now has an explicit visible label association.
The application review wraps long names; a disposable 64-character unbroken
name exercises both its closed and open layout at 320px and 200% root text size.
The review itself writes nothing and sends no provider/count request; fixture
creation and deletion are two separately checked local-registry revisions.

Compatibility inspection previously cleared the entire result subtree for every
settings change, then recreated each detailed blocked/constraint alert. The
result now keeps all reasons available as ordinary text, with one persistent
atomic status node for the last settled semantic outcome. Pending checks retain
that explicitly historical wording; unchanged settled outcomes do not mutate the
live text. A different thread/context/branch/target clears the retained outcome.
Inspection freshness, cancellation, exact review keys and Send gating are
unchanged. A stable announcement never authorizes a request.

The first integrated run exposed a lifecycle regression: keeping the routing
hook in AppRoot while conditionally mounting its section left its listeners and
remembered focus detached from the section lifetime. Opening an imported
conversation then failed the existing heading-focus check. The [retained failure](results/attempts/action-accessibility-routing-lifecycle/app-browser.json)
records that regression. The routing child now owns both section and hook, so
unmounting the panel clears its recovery state. The same complete scenario
rechecks imported-conversation focus after routing interaction.

The [recovery-layout attempt](results/attempts/action-accessibility-recovery-layout/app-browser.json)
failed when pointer activation did not expose the Title input after focus left
the newly revealed heading. Keeping that heading visible avoids the collapse on
blur; the scenario retains the pointer activation and an explicit visible-input
assertion. Earlier test setup mistakes (candidate value encoding and attempting
to dismiss a session notice that has no Dismiss control, and holding a reply
before the unknown-outcome error had appeared) are also retained under
`results/attempts/`; they do not count as application passes.

## Verification

Final qualification passes **59 groups in Chromium and 59 in Playwright
WebKit**, **74 switching tests**, **12 preference/alias tests**, **11 library
controller tests**, and `npm run check` on macOS 26.6.2 / arm64 / Node 22.23.1.
The [application report](results/action-accessibility-app-macos.json) and
[aggregate record](results/action-accessibility-checks-macos.json) verify 93
unchanged browser source hashes, the additional controller test source, and
31 retained artifacts. Representative recovery-heading and alias-layout
screenshots were visually inspected in both engines.

The new scenarios exercise
actual accessible names, native keyboard activation, disabled Send, exact
canonical preservation, no provider traffic from inspection/review, and a held
reconciliation reply while focus moves to Title. Existing edit/quote/branch,
provider-switch, summary, archive and restart checks stay in the complete run.

The compatibility scenario uses the imported ProviderArtifact-bearing branch,
edits three distinct valid output limits and restores the original, checking
node identity, zero live-text mutations for the unchanged blocked outcome,
retained reasons, focused numeric input and unchanged unsent draft. Selecting a
compatible text branch changes the semantic announcement; changing settings after
review invalidates the consent checkbox and keeps Send disabled.

DOM and computed-layout assertions do not establish actual screen-reader
utterances, speech recognition, native popup painting, installed Safari, desktop
host accessibility or complete WCAG conformance. Pending-outcome recovery across
conversation navigation and search is a separate remaining path: those controller
operations currently clear the ordinary error field, which owns the recovery
control. The next slice must qualify and preserve that recovery path. Broader gates remain in the
[accessibility findings](accessibility-open-findings.md).

## References

Reviewed 2026-09-10: W3C [Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html)
supports retaining the visible action words in an accessible name. W3C
[Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages)
and [ARIA22](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA22) describe exposing
status without moving focus. These references guide the implementation; the
bounded browser checks do not certify full conformance.
