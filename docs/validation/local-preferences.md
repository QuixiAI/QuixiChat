# Local preference acceptance

2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. This slice implements the shared
local settings decision in [ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md)
and one preference: Enter versus Mod+Enter in the composer.

## Implementation and limits

[Typed contracts](../../packages/core/src/contracts/preferences.ts) expose a read
and conditional send-key update. The [worker repository](../../packages/storage/src/worker/preferences.ts)
stores a versioned row in the existing local-state table. No migration, canonical
record or sync operation is created. The worker's normal selection fence and
bounded request queue apply. Invalid/future rows remain unchanged and produce
an actionable error. Another tab's stale revision cannot overwrite a newer row.

The [controller](../../packages/app/src/features/preferences/controller.ts)
allows one operation at a time, reads on mount/settings entry/window focus, and
requires a successful read after a failed or lost save reply before further
editing. It never blindly retries a write. The Preferences panel describes the
archive/device/profile scope and offers reload. Loading/saving/errors disable
keyboard submission while preserving the draft and button submission path.
Portable/open exports and cleaned rescue restores exclude these local choices;
raw byte-level rescue retains the database as originally stored.

The composer uses the same send validation for both shortcuts. Mod+Enter remains
the default, Enter mode keeps Shift+Enter for newlines, and composition/repeated
keydown events never send. Appearance does not control this setting. This does
not implement the other interaction preferences, themes or reusable aliases.

## Evidence

The [retained unit results](results/local-preferences-unit-macos.json) contain
full command output and source hashes, refreshed with the alias regression run:

- `npm run test:core`: **51 passed**.
- `npm run test:storage:canonical`: **40 passed**, including defaults without a
  write, stale revisions, actual SQLite close/reopen, no canonical/sync effects,
  invalid/future rows preserved, rollback, and invalid request refusal.
- `npm run test:app:preferences`: **7 passed**, including lost-reply recovery,
  bounded concurrent calls, invalid-read recovery and keyboard guards.
- `npm run test:app:switching`: **21 passed**.
- Archive test typecheck plus `node --experimental-transform-types --test
  packages/storage/tests/archives/sqlite-file.test.ts`: **10 passed**. The
  clean-copy test now saves Enter in the source, proves it stays there, and
  proves the export/restore candidate has only the workspace identity and the
  default preference while preserving canonical content.

`npm run test:app:browser`: **32 checks in each of Chromium and WebKit**, retained
in the [shared-app report](results/shared-app-macos-26.6.2.json), with all 46 listed
source hashes checked against the final files. The preference scenario uses the real
shared app, production worker/OPFS and host/provider adapters with synthetic
loopback HTTP. It covers saving without altering a draft, a deliberately lost
reply after a real durable save and UI read recovery, another browser client's
read/stale-write refusal, both shortcuts reaching the provider, actual newline
entry, composition/repeat guards, and a fresh browser process retaining Enter.
The narrow WebKit composer capture was visually inspected and fits its viewport.

The initial run found an ambiguous accessible label on the selector; the final
label uses an explicit control association. A later run exposed a stale routing
test assumption: after an OpenAI routed attempt, returning to Anthropic must
remain disabled until its new switch report is reviewed. The final test asserts
both refusal and subsequent enablement, strengthening the existing gate.

`npm run check` passed (SQLite artifact verification, typecheck, both host
frontend builds). The existing large-bundle warning remains. Browser automation
does not establish installed Safari/Tauri support or native OS input-method
behavior. No paid provider, private history, OCR, Cloud, deployment or publication
was involved. Native preference/input-method exercise remains a release gate.

## Compaction regression refresh — 2026-09-10

The retained unit report was refreshed against the final attachment-compaction
sources: 52 core, 42 storage, 7 preference/controller, 21 switching, 9 attachment
and 13 archive Node tests pass (144 total), plus `npm run check`. The shared app
report now has 33 passing groups in each browser, including the existing
preference/alias checks. Earlier counts above describe the original feature slice.
[Compaction acceptance](context-compaction.md) records schema 11/protocol 3,
portable restore and remaining gates; summary and explicit branch choices stay open.

## Version 4 — 2026-09-12

`theme` (one of the six product §92 names) joins the closed row; `setTheme`
writes it under the same conditional revision. Versions 1–3 normalize to
version 4 with `theme: "warm-reading"`; an unknown theme or an unsupported
version is refused with the stored row preserved ([ADR 0039](../decisions/0039-appearance-themes.md)).
