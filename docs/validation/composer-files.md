# Composer PDF files

The shared application browser proof includes a synthetic PDF workflow alongside
the existing image picker, drop, removal and preview checks. The PDF scenario
mounts the production application, browser host and StorageWorker. Its provider
server returns synthetic protocol responses; no provider account or model is used.

## Qualification

The final `npm run test:app:browser` run passes **44 checks in Chromium and
44 in Playwright WebKit** on macOS 26.6.2. The
[application report](results/composer-files-app-macos.json) records each engine,
check descriptions, original attachment SHA-256, portable archive SHA-256 and
source hashes; the runner confirms sources stayed unchanged during the run.
The [aggregate record](results/composer-files-checks-macos.json) verifies all 86
source hashes across the application and provider reports against the final
worktree, and records commands, logs, screenshots and earlier attempts. No
historical failure report was overwritten to claim a pass.

The supporting suites pass on the same implementation; their retained logs are
under [results/composer-files](results/composer-files/):

| Check | Result | Evidence |
| --- | --- | --- |
| Provider units and typechecks | 51 passed | [log](results/composer-files/provider-units.log) |
| Chat switching/context workflows | 74 passed | [log](results/composer-files/switching-units.log) |
| Attachment staging/controller | 28 passed | [log](results/composer-files/attachment-units.log) |
| Provider settings/regional capability guard | 16 passed | [log](results/composer-files/provider-settings-units.log) |
| Browser host OAuth units | 12 passed | [log](results/composer-files/oauth-units.log) |
| Browser host regression | 30 passed | [log](results/composer-files/host-browser.log) |
| Provider browser persistence | 23 per engine | [report](results/composer-files-provider-browser-macos.json) |
| Workspace check | Passed after navigation correction | [log](results/composer-files/check.log) |

The provider Node suite initially exposed an unguarded `window` access in the
browser host's OAuth event registration. Environment guards now allow that host
to run in the existing Node fixture; the provider, OAuth and host regressions
above pass. The [initial failure](results/attempts/composer-files-node-host-initial.log)
is preserved.

The scenario checks:

- Picker selection and drag-and-drop of a small, generated PDF; filename/size
  metadata, removal, and refusal of unsupported, oversized and mislabeled files.
  A staged PDF has no image, iframe, object or embed preview.
- Canonical `File` parts and published `Attachment` metadata. Bounded worker
  reads recompute the original PDF digest. A removed draft is not published.
- OpenAI Chat Completions file data URLs and Anthropic Messages base64 PDF
  document blocks carry the exact original bytes. Anthropic prompt counting and
  regeneration use the same saved PDF; OpenAI regeneration also preserves it.
  The application performs no PDF-to-text conversion.
- Switching PDF history to the reviewed regional OpenAI connection blocks File
  content before counting, creating an attempt or sending provider HTTP. Toggling
  regional image eligibility updates the compatibility report under the same
  provider/model identifiers: the staged image becomes blocked and eligible
  again, while the PDF remains blocked and provider HTTP stays unchanged.
- A downloaded portable TAR contains those same bytes. A separate production
  managed-archive composition selects the TAR through the file picker, validates
  it, requires replacement review, activates and opens the restored archive,
  verifies `File`/`Attachment` records and bytes, then regenerates using the
  restored PDF.
- A browser-process restart preserves PDF history, metadata and byte hashes
  without credentials or provider HTTP; the narrow layout remains usable.

The restore composition uses the disposable test profile and localhost fixture
origin, separately from the primary `test-*` archive. It does not copy files into
a candidate or bypass the production archive validation and activation protocol.

## Restore navigation failure and correction

An earlier revision passed 44 checks in each engine, retained in the
[before-cache-fix report](results/attempts/composer-files-before-cache-fix-macos.json).
After compatibility-cache invalidation and its regression were added, Chromium
passed 44 checks but WebKit stopped after 35 when opening the restored PDF
notebook. The [initial report](results/attempts/composer-files-webkit-restore-initial-macos.json)
and [initial log](results/attempts/composer-files-webkit-restore-initial.log) preserve
that failure.

A focused WebKit reproduction added bounded diagnostics without extending the
assertion timeout or changing navigation. The
[restored-page diagnostic](results/attempts/composer-files-webkit-restore-diagnostic.json)
records `readThreadView` at 3752 ms, followed at 3753 ms by rejection because the
active archive had changed. Initialization requests for the new mount begin at
3907 ms and its library read completes at 3939 ms. The click reached the prior
archive context before the replacement application mounted; it did not select a
thread in the new mount. The final page shows the library landing heading and no
page errors. The [screenshot](results/attempts/composer-files-webkit-restore-diagnostic.png),
[run report](results/attempts/composer-files-webkit-restore-diagnostic-macos.json)
and [full log](results/attempts/composer-files-webkit-restore-diagnostic.log) are
retained alongside the diagnostic.

The application correction disables library thread buttons and new-conversation
controls while the archive is opening or its selection has changed, and guards
the navigation handler against those states. The
[focused corrected WebKit run](results/attempts/composer-files-webkit-restore-fixed-macos.json)
and final two-engine run both pass all 44 checks with unchanged navigation
assertions and timeouts.

An earlier probe considered whether continuous storage-change notifications
could supersede a slow conversation load. The [probe source](results/attempts/library-refresh-continuous-changes-probe.ts)
and [output](results/attempts/library-refresh-continuous-changes-probe.log) are
retained as a separate follow-up; the recorded failure demonstrates stale archive navigation and does not establish
continuous notifications as its cause.

## Scope

Staging recognizes the PDF signature and verifies byte length and SHA-256; this
is not a PDF parser or proof that a provider accepts every PDF. Provider page
limits, encryption and account eligibility remain provider-specific. OpenAI
prompt counting is unavailable in the reviewed Chat Completions adapter.
Chromium and Playwright WebKit results do not establish installed Safari support.

The final [staged PDF metadata](results/composer-files/composer-files-webkit-staged.png)
and [narrow restarted conversation](results/composer-files/composer-files-webkit-restart.png)
were visually inspected; labels and controls remain readable and the file is
present without credentials. These representative screenshots do not complete
the broader accessibility audit.

The shared limits are 20 attachments, 2.5 MiB of original image/file bytes and a
4 MiB encoded request. Unit/workflow tests cover limit and unavailable-file
refusals beyond the representative browser cases.

Sources: [browser scenario](../../packages/app/tests/browser/composer-files.mjs),
[bounded byte verification](../../packages/app/tests/browser/composer-files-storage.ts),
[managed restore composition](../../packages/app/tests/browser/composer-files-restore.ts),
and [application runner](../../packages/app/tests/browser/run.mjs).
