# Presentation review: warnings, recoverable errors, empty states, progress and cancellation

Date: 2026-09-12. Plan: [13](../plans/13_complete_onboarding_appearance_and_accessibility.md).
A review of every completed workflow's user-facing states against the retained
browser proofs. "Proof" names the record that exercises the state in Chromium
and WebKit; "source" means the state exists in source and is rendered by the
proofs' pages but not asserted on its own.

| Area | Warning review | Recoverable error state | Empty state | Progress and cancellation |
| --- | --- | --- | --- | --- |
| Library and conversation | compatibility and switch reports before a consequential send ([action-accessibility.md](action-accessibility.md), [shared-app.md](shared-app.md)) | ordinary errors dismissible, pending-change recovery with its own region ([pending-recovery.md](pending-recovery.md)) | "No conversations in this view."; new: "No messages yet…" above the composer (proof) | streaming status in one polite region, Stop response, stopped/partial attempts retained ([shared-app.md](shared-app.md)) |
| Search | mode line names unavailable semantic search with its reason (proof) | search notices for refused queries (proof) | new: "No matches…" inside the results region (proof) | pending-source count on the mode line (proof) |
| Imports | source-specific warning review (missing attachment, unsupported content) and extension offer provenance ([extension-import.md](extension-import.md)) | paused runs with their cause, Resume/Retry from staged bytes, storage-full wording ([extension-import.md](extension-import.md)) | "No imports on this page." (proof) | phase names, pause after the current step, discard of unfinished work (imports proof) |
| Archives | replacement review and explicit activation ([archive-client.md](archive-client.md)) | refused containers with a named cause, active archive intact ([archive-scale.md](archive-scale.md)) | idle export/restore panels state what each format contains (source) | phase and byte progress, Cancel preparation, bounded steps ([archive-scale.md](archive-scale.md)) |
| Providers | health states with reasons and retry times (proof) | connection setup errors with Retry connection setup (source) | new: "No provider connections are configured on this host…" (source; every proof configures connections) | account-health re-check (proof) |
| Semantic search | unavailable-host alert, model refusal ([semantic-search.md](semantic-search.md)) | runtime failed / rejected publications (proof) | pre-enrolment explanation with Enable/Later (proof) | indexed count, speed, ETA, Pause/Resume/Delete ([semantic-search.md](semantic-search.md)) |
| Onboarding and storage | capability check marks, ungranted persistence warning ([onboarding.md](onboarding.md)) | startup outcome view with retry and rescue export ([storage-proof.md](storage-proof.md)) | first-run steps on the empty landing page (proof) | Check again, request persistence with the actual answer (proof) |
| Preferences and themes | theme change keeps the saved status visible ([interaction-preferences.md](interaction-preferences.md)) | lost reply and stale revision refusals with Reload (proof) | — | saving status per change (proof) |
| Compaction and branches | attachment/summary/fresh-branch reviews before apply ([context-compaction.md](context-compaction.md), [context-summaries.md](context-summaries.md), [context-branches.md](context-branches.md)) | stale-scope consent expiry, cancellation with focus retained ([review-accessibility.md](review-accessibility.md)) | — | Working status, Stop summary operation (proof) |

Added by this review: the search no-match state, the empty-conversation
state and the providers empty state. The first two are asserted in the
shared-app proof (90 checks per engine); the providers one is source-only
because every proof configures at least one connection.
