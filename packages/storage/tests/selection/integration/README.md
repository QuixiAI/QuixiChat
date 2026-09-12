# Production managed archive activation acceptance

This harness uses the public `@quixi/storage/client` exports:
`openActiveStorageClient`, `readArchiveSelection`, `archiveActivationStatus` and
the bounded retained-archive reader. It creates canonical records through the
real owner/follower StorageClient, produces a portable export, streams it into a
real restore job, obtains a persisted review, and calls `activateRestoredArchive`.
There is no direct catalog switch, activation hook, replacement SQLite backend
or mocked archive result.

Run from the repository root:

```sh
npx tsc --noEmit -p packages/storage/tests/selection/integration/tsconfig.json
node packages/storage/tests/selection/integration/run.mjs
```

The shared `QUIXI_TEST_BROWSERS` selector applies. The runner records OS/browser
identity, source hashes and the OS-assigned origin in
`test-results/production-activation-browser.json`. The same origin remains active
through its deliberate browser-process restart. Initial OPFS must be empty; the
test does not clear or repair unexpected archives.

The retained [browser evidence](browser-evidence.json) passes all nine groups in
Chromium and WebKit on macOS 26.6.2 arm64. It includes the source hashes used for
that run; these results qualify the production storage paths exercised below.

## Why the origin is allocated per run

This Playwright WebKit build exposed existing OPFS from a previous fixed-origin
run despite a different temporary persistent-profile directory. The retained
[fixed-origin negative report](webkit-fixed-origin-negative.json) records existing
`quixi` and candidate directories **before any production API call**. Its earlier
deliberate catalog deletion left the bootstrap marker, and startup correctly
refused default fallback. A fresh profile path alone was therefore insufficient
test isolation for this backend. The OS-assigned origin fixes the fixture without
deleting that previous data or weakening bootstrap recovery checks.

## Work exercised

The synthetic fixture includes exact NUL/Unicode message text and 2 MiB + 17
original binary bytes. Portable TAR transfer uses at most 64 KiB per chunk and
one acknowledged chunk at a time, without materializing an entire export in JS.
Archive work advances through bounded public steps. Verification hashes restored
blob chunks incrementally and reads bounded canonical pages.

The acceptance covers:

- Default bootstrap at canonical schema 9, actual owner/follower writes, client
  closure and reopen.
- Portable export, isolated restore validation and review preparation without
  changing selection.
- Rejection of a forged complete candidate summary, a source sync high-water
  changed after review, and a positively live registered generation. Completing
  the generation as partial and releasing its producer permits a fresh review.
- Real activation with its successful reply deliberately dropped at the client
  boundary. The pending request must report `UNKNOWN_OUTCOME`, its original
  operation ID and `same_operation_id`; the independent global status returns
  the committed receipt. Later stale writes remain `CONFLICT`.
- Opening the actual selected candidate and verifying exact snapshot records,
  message text, original blob digest and workspace identity. Source records made
  after the snapshot are absent from the selected replacement and remain present
  through the public retained source reader.
- Global receipt and retained source sync-history access after source clients
  close, followed by complete persistent browser-process restart.
- Deliberate deletion of the selected namespace: normal selection/open fail,
  while the committed global receipt and retained source remain inspectable;
  there is no replacement empty archive.
- Subsequent deletion of the entire catalog root: the surviving default archive's
  bootstrap marker prevents silent default adoption. The retained default remains
  readable independently; the deliberately deleted candidate stays absent.

Fault injection only suppresses a real worker reply or removes test-owned OPFS
directories after clients close. It does not change activation logic. The source
producer holds the actual independent generation Web Lock; no external provider
request is made. This validates production storage integration, not the final UI
gesture, deployed service-worker upgrade cohort or installed native WebView.

## Retained operation reconciliation

Run `node packages/storage/tests/selection/integration/reconcile.mjs` for the
focused `reconcilePreviousArchiveOperations` acceptance. It performs the real
portable export, restore and activation setup, then checks only the added helper
behavior. The [retained reconciliation evidence](reconcile-browser-evidence.json)
passes both groups in Chromium and WebKit; its source hashes include the helper
and the updated retained reader. The earlier nine-group report above remains
evidence for its recorded revision.

Two canonical operations committed after the snapshot exist only in the retained
source. Their identities resolve as `committed`; two fresh identities resolve as
`not_committed`; a mixed list, duplicate identities, an empty list and an invalid
identity reject. Exact source receipts and its bounded sync page remain unchanged,
as do selected canonical and sync counts. No source-only thread appears in the
selected archive. Attempting reconciliation on the currently selected client
rejects before closing it, demonstrated by a subsequent successful canonical
write and read through that same client.
