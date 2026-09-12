# Interaction preferences

The shared application browser proof exercises the production Preferences panel,
application, browser host and elected StorageWorker in an isolated synthetic
archive. No provider account or external model is used.

## Qualification

The final run on macOS 26.6.2 passes **46 checks in Chromium and 46 in
Playwright WebKit**, including the existing send-key, provider, branch and archive
flows. The [application report](results/interaction-preferences-app-macos.json)
records both engines, canonical fingerprints, exact saved preference revisions
and source hashes. The [aggregate record](results/interaction-preferences-checks-macos.json)
verifies 84 current source hashes and retains commands, logs and screenshots.
Application sources did not change during qualification.

| Check | Result | Evidence |
| --- | --- | --- |
| Core contracts | 65 passed | [log](results/interaction-preferences/core.log) |
| Canonical SQLite repositories | 57 passed | [log](results/interaction-preferences/canonical.log) |
| Archive cleanup/export | 13 passed | [log](results/interaction-preferences/archive-node.log) |
| Preference/alias controllers | 12 passed | [log](results/interaction-preferences/app-preferences.log) |
| Shared browser application | 46 per engine | [report](results/interaction-preferences-app-macos.json) |
| Workspace check | Passed | [log](results/interaction-preferences/check.log) |

Core/storage tests cover closed version-1 normalization without a write, version-2
validation, stale conditional writes, interrupted transactions, reopening the
actual SQLite file, preservation of sibling choices, unknown operation refusal,
and exclusion from cleaned archives. Preference controllers retain the current
choices on failure, admit one I/O operation at a time and never replay writes.
[ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md#complete-interaction-preferences--2026-09-10)
records the schema and presentation decisions.

The focused scenario verifies:

- Defaults hide message timestamps, show model badges, use the comfortable
  composer and display the model dropdown. All four alternate preferences save
  through the production storage operation while a draft remains intact.
- Timestamps expose valid machine-readable dates, hiding badges leaves attempt
  status visible, compact layout uses two textarea rows, and the model list
  exposes native radios. Keyboard activation preserves the currently selected
  reviewed catalog model.
- A simulated lost reply after a durable preference write produces an error and
  disables preference changes until reload recovers the stored value. A second
  production client saves a new revision; the original panel's stale UI edit is
  refused, and reload reveals the winning value.
- Returning all four preferences to their defaults preserves the draft and
  send-key preference. Canonical entity fingerprints, sync high-water sequence,
  content HTTP and token-count HTTP remain unchanged throughout these changes.
- All four alternate preferences and their exact revision survive a fresh
  browser process in the same profile. History renders without credentials or
  provider HTTP at a 390-pixel viewport. Defaults are restored before the other
  restart scenarios continue.

The [wide compact composer](results/interaction-preferences/interaction-preferences-chromium-alternate.png)
and [narrow restarted history](results/interaction-preferences/interaction-preferences-webkit-restart.png)
were visually inspected: timestamps/status remain readable, the model list is
focusable when a provider is configured, the unavailable-model state is explicit
after restart, and the compact controls fit the narrow page.

The existing send-key proof remains part of the same run. These preferences are
local to the archive and device profile, not canonical conversation settings or
portable history. The browser scenario does not claim cross-device preference
sync or installed Safari qualification. Timestamp formatting uses the runtime's
locale and timezone; the test checks valid dates rather than one locale's text.

Sources: [focused browser scenario](../../packages/app/tests/browser/interaction-preferences.mjs),
[browser fixture](../../packages/app/tests/browser/index.ts), and
[application runner](../../packages/app/tests/browser/run.mjs).

## Themes — 2026-09-12 ([ADR 0039](../decisions/0039-appearance-themes.md))

Local preferences are version 4 with a `theme` field and a `setTheme`
operation; rows from versions 1–3 normalize to version 4 with the default
theme (core preference tests, canonical preference tests). The shared-app
proof (87 checks per engine, Chromium and WebKit) switches through all six
built-in themes from the Preferences panel and, for each, checks the root
`data-theme` attribute, the computed page background and body/muted text
contrast, that the interaction preferences are unchanged apart from the
revision, and that the "Preferences are saved on this device." status stays
visible; six distinct backgrounds and a monospace body font under Terminal
are asserted. Chromium sample:

| Theme | Page background | Body text contrast | Muted text contrast | Body font |
| --- | --- | --- | --- | --- |
| cool-minimal | rgb(247, 248, 250) | 13.89 | 5.71 | Inter |
| compact-ops | rgb(244, 246, 248) | 14.42 | 6.22 | Inter |
| terminal | rgb(15, 20, 18) | 14.03 | 8.39 | ui-monospace |
| bubbles | rgb(251, 251, 253) | 13.18 | 5.75 | Inter |
| focus | rgb(252, 252, 250) | 13.97 | 6.22 | Inter |
| warm-reading | rgb(249, 250, 247) | 12.55 | 5.7 | Inter |
