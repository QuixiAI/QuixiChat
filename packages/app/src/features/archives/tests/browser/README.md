# Production restore UI acceptance

From the repository root:

```sh
npx tsc --noEmit -p packages/app/src/features/archives/tests/browser/tsconfig.json
node packages/app/src/features/archives/tests/browser/run.mjs
```

The runner uses the installed Playwright Chromium and WebKit engines by default. `QUIXI_TEST_BROWSERS=chromium` or `QUIXI_TEST_BROWSERS=webkit` selects one engine through the shared validated selector. CI needs the selected Playwright browser and its OS dependencies. Vite binds a fresh loopback port with the production isolation headers; each engine gets a fresh persistent profile. Temporary builds, downloads and profiles are removed at the end. No provider request, credential, external deployment or existing user archive is involved.

The test HTML imports the actual `apps/web/src/main.ts`, shared AppRoot and production WebHost. It does not use the isolated storage test client or mount a substitute app. The small helper uses public managed clients solely to seed a synthetic message/raw object and inspect bounded canonical, sync, selection and original-byte evidence. The user-facing creation, rename, export, download cleanup, file picker, review, confirmation, open and draft actions go through the real UI. The optional `showSaveFilePicker` is explicitly disabled to exercise the production disk-backed browser-download fallback; this does not qualify native OS save dialogs.

Seven grouped checks per engine cover:

- A real portable TAR download with a synthetic original file of 2 MiB + 17 bytes, and explicit temporary-download cleanup without canonical changes.
- Real browser file selection and isolated candidate validation, with no implicit activation; drafts block both review and confirmation and retain their exact text.
- Reloading a previously reviewed ready candidate, discovering the exact saved job through Review saved restore, and requiring a fresh review without implicit activation or canonical changes.
- Explicit replacement that returns a committed selection without remounting; another tab receives the selection hint and keeps its visible unsent draft with opening disabled.
- A separate Open restored archive action that remounts the production app, restores saved message text and original workspace, preserves exact messages/parts/thread states/sync, verifies original bytes and retains the old archive's later title edit.
- A fresh browser process opening the committed selection and creating its next conversation in the restored default workspace.
- No external HTTP requests/page errors and no horizontal overflow at a 390-pixel viewport. Review and restored-conversation screenshots are retained for visual inspection.

The first real file selection exposed a host defect: a roughly 2.8 MiB selected TAR could produce a `File.stream()` chunk exceeding the host's 1 MiB source guard. `openFileTransfer` now uses demand-driven 64 KiB `File.slice().arrayBuffer()` reads, a zero-prefetch stream and a cancellation fence. The multi-MiB actual file-picker restore is the regression case. The separate existing web-host suite passed all 24 tests after this fix. Canonical blob readback has its own core `MAX_TRANSFER_BYTES` contract (1 MiB); the report records that separate limit and observed peak, rather than conflating it with archive/file-upload windows.

Artifacts are written under `results/`: `restore-ui-browser.json`, `<engine>-review-mobile.png`, `<engine>-other-tab-draft.png`, and `<engine>-restored-mobile.png`. The JSON includes OS/runtime/browser identity, source fingerprints, canonical schema/counts, archive checksum, old/new selection, verified blob hash/length/peak, timestamps and assertion groups. A source changing during execution produces `source_changed`, not a clean pass.

The bounded synthetic fixture does not qualify full archive-scale memory, native desktop hosts, crash/lost-reply receipt recovery, or a pending canonical request crossing activation. Those remain separate production storage/controller/session proofs. The UI preserves saved unfinished prefixes and does not infer producer loss or resume provider requests.

The final stable schema 10 refresh passed all seven groups in both engines, including the saved-ready-job reload case. The preceding startup timeout had the welcome view already rendered by its failure snapshot and no page errors; an unchanged rerun passed. The retained JSON contains only this successful stable-build run, with exact source fingerprints.
