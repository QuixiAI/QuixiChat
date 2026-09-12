# Production archive protocol browser evidence

Run from the repository root after provisioning the pinned SQLite distribution
and Playwright browsers:

```sh
node packages/storage/tests/protocol/run.mjs
```

The shared `QUIXI_TEST_BROWSERS` selector defaults to Chromium and WebKit. The
runner builds the actual production client, catalog resolver and archive worker,
uses disposable persistent profiles and a fresh OS-assigned loopback port, and
writes `test-results/archive-protocol.json`. It records running/failed status
before execution and only marks success after both selected engines finish.

The current [schema 12 / protocol 4 report](../../../../docs/validation/results/context-summaries-protocol-macos.json)
passes six groups per engine, with strict version-4 envelopes, explicit older-version
rejection and no owner advertisement on the legacy channels. The runner resets only the two
synthetic default stores in its disposable profile before opening workers.
[Summary validation](../../../../docs/validation/context-summaries.md) records the current evidence.
The earlier [attachment compaction proof](../../../../docs/validation/context-compaction.md)
retains its schema-11 report and fixture-isolation history.

The [historical schema 10 report](evidence/managed-schema10/browser-evidence.json)
passes all six groups in Chromium and WebKit on macOS arm64. Actual owner and
reopened diagnostics report schema version 10. Its final human-readable check
still says “schema9”; that stale label was corrected in the current runner after
capture, without changing test behavior or rewriting the report's original source
hashes. [The captured runner](evidence/managed-schema10/runner-at-capture.mjs)
retains the exact source bytes used for this run; it is a source snapshot, not a
standalone relocated command. [Checksums](evidence/managed-schema10/checksums.json)
cover the current retained report and runner snapshot. Use the command above to
run the current source.

The [managed schema 9 report](evidence/managed-schema9/browser-evidence.json)
passed six groups in each engine on macOS arm64. It records exact source and
built artifact hashes, browser user agents, actual lock observations, rejections,
selected archive/revision and canonical operation counts. The harness uses public
`openActiveStorageClient()` for the managed default archive. It does not use the
private isolated test factory or a cooperative owner implementation.

The following enumerates the historical protocol-2 baseline; the current runner
uses version 4 and additionally rejects versions 2 and 3.

1. Actual modern owner and follower commit through the production client. Both
   report the same owner; Web Locks show one held and one pending owner request.
   Outer frames are version 2 and inner canonical `StorageRequest` remains 1.
2. The unchanged frozen schema 8 follower emits its real v1 hello and queues on
   the same owner lock. No v1 owner advertisement arrives; its canonical write
   remains undispatched while legitimate modern commits progress.
3. Valid canonical writes wrapped in missing, numeric 1/3 or string `"2"` outer
   versions are posted to the v2 BroadcastChannel. A subsequent valid hello from
   the same sender produces an owner reply, establishing a processing barrier.
   Canonical/sync counts remain unchanged, and a subsequent modern commit works.
4. An initialized actual worker rejects the same unsupported direct call
   versions with version 2 `UNSUPPORTED` replies, before mutation. A valid direct
   call then succeeds on that worker with its pinned selection.
5. Unsupported direct init versions return a fatal `UNSUPPORTED` before creating
   the supplied archive namespace or owner lock. The established modern session
   remains writable. A rejected initial worker is discarded; recovery on that
   worker is not part of the contract.
6. After modern clients close, the old waiter acquires the lock and rejects the
   committed schema 9 ledger with `MIGRATION_FAILED` before its queued write.
   A modern reopen preserves exactly six committed sync operations, canonical
   record count and SQLite integrity.

The final check depends on **both** the committed schema barrier and protocol
isolation. Protocol versioning alone does not prevent an old worker from opening
an older database after the modern owner exits. The separate
[frozen schema 8 proof](../selection/schema8/README.md) covers upgrade rollback,
interruption and old-process restart. This fixture does not claim an archive
activation switch, crash recovery of a selection transition, broader browser
hardware coverage, or installed Safari/Tauri qualification.

## Frozen inputs and retained failures

The runner verifies the exact [schema 8 frozen manifest](../selection/schema8/frozen/manifest.json)
and copies its unchanged worker bundle plus matching pinned SQLite WASM into the
temporary server. It never rebuilds or modifies the old worker. Modern workers
are separately built from current production sources.

The [initial protocol 2 baseline](evidence/protocol2-baseline/browser-evidence.json)
also passed both engines before managed selection/schema 9 integration. That
baseline terminated the old waiter before releasing the modern owner and made
no schema barrier claim. Its exact harness inputs are retained beside the report
as historical evidence, not an alternate current test entry point.

A later [fixed-origin attempt](evidence/protocol9-before-origin-isolation/browser-evidence.json)
passed Chromium but observed six pre-existing default-archive operations in
WebKit despite a new profile path. The fixture now uses a fresh loopback origin
as well as profile paths. It does not delete existing site data or interpret
pre-existing rows as a production protocol failure.

## Existing fixture migration

The production factory now requires a managed selection. Existing synthetic
storage, provider, importer, app, import-panel and content browser fixtures import
the private `createIsolatedStorageClient` explicitly and supply `test-*` source
archive IDs. Their test entry installs the isolated policy on the same archive
runtime; it cannot silently prefix a production namespace. The protocol fixture
above continues to exercise the actual managed production entry.

The archive roundtrip fixture preserves the generated candidate UUID. Its
existing private SQL worker now inspects that candidate under its real owner
lock with `PRAGMA query_only=ON`, checks canonical/sync counts and integrity, and
hashes the 9 MiB blob in 64 KiB blocks. It does not open the candidate through a
writable archive client or change the production candidate allocator. Query-only
inspection is a logical read contract, not a claim that opening SQLite/SAH pools
is byte-for-byte inert.

The [migration evidence directory](evidence/fixture-migration/) retains affected
browser reports. Storage/archive, provider, importer, app, import panel and
content fixtures run Chromium and WebKit; relevant storage/archive/app/provider/
importer TypeScript checks also pass. These tests validate the fixture migration,
not new user-facing behavior or release performance.

The provider runner initially completed all 23 behavioral checks per engine but
failed final report fingerprinting because its shared browser-selector path was
resolved under `packages/providers`. The failed report is retained; correcting
that relative path produced a complete successful rerun. Content and app runners
both use port 4197 and must run sequentially; an initial overlapping app launch
was retried after content completed, without stopping another process.

Archived harness inputs, raw reports and checksums are evidence snapshots.
`evidence/checksums.json` covers every retained evidence file except itself.
