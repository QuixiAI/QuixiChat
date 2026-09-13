# Storage stress: 100k conversations, 1M+ messages

Plan [24](../plans/24_validate_scale_and_release_hosts.md) task 5 ("run
storage/import stress workloads at 100k threads, 1M+ messages …; measure
startup, migration, quota failure, concurrent tabs, interrupted writes,
export, and restore without archive-wide materialization"). Harness:
`npm run test:app:stress:browser` (`packages/app/tests/browser/stress.mjs`),
sizes from `QUIXI_STRESS_THREADS` / `QUIXI_STRESS_PER_THREAD`, engine from
`QUIXI_TEST_BROWSERS`. macOS 26.6.2 (arm64), Node v22.23.1.

## What the harness measures

Seeded through the production Storage Worker in bounded commits of at most
125 mutations (synthetic short messages; no embedding model, provider or
Cloud account), then in order:

1. **Integrity** — the light `diagnostics` read (record and sync-operation
   counts, usage, file size; integrity only within the 256 MiB startup bound,
   otherwise `unchecked`), then the explicit `diagnosticsReport` requested
   with `INTEGRITY_CHECK_DEADLINE_MS`, whose full `PRAGMA integrity_check`
   must answer `ok`; its own elapsed time is recorded.
2. **Library paging** — the first library page and twenty consecutive pages
   of 64 conversations, timed individually; the archive is never listed whole.
3. **Cold reopen (startup)** — the page and worker are closed and a fresh
   page opens the persisted archive; time to the landing view and to the
   first library page.
4. **Concurrent tab** — a second page opens the same archive and reads three
   library pages through the owner's coordination.
5. **Portable export** — produced in bounded steps (≤128 records, ≤1 MiB per
   step) and streamed to the runner's disk block by block (64 chunks per
   read), digest verified on disk; the page never holds the container.
6. **Restore validation** — the container is streamed back from disk in
   4 MiB blocks into an isolated candidate that is validated in bounded steps
   and released, never activated; its record count must equal the source's.

## Smoke run (both engines, 300 conversations, 3,000 messages)

[storage-stress-smoke-macos.json](results/storage-stress-smoke-macos.json), 6 checks per engine.

| Phase | Chromium | WebKit |
| --- | --- | --- |
| seed (30 commits) | 3.0 s (1,003 msg/s) | 2.2 s (1,334 msg/s) |
| integrity_check over 6,900 records | 40 ms | 39 ms |
| library first page / 5 pages | 43 ms / 198 ms | 41 ms / 186 ms |
| cold reopen: landing / first page | 167 ms / 81 ms | 384 ms / 45 ms |
| follower tab: 3 pages | 163 ms | 122 ms |
| portable export: 12.4 MB / steps / produced | 176 / 46.6 s | 176 / 8.8 s |
| export streamed out (200 chunks) | 0.3 s | 0.3 s |
| restore validation: steps / time | 297 / 6 s | 297 / 4 s |

Chromium's export is slower per step because of its OPFS commit cost, as
[archive-scale.md](archive-scale.md) recorded at 30,000 messages.

## Full run (WebKit, 100,000 conversations, 1,000,000 messages)

**First attempt (2026-09-13), failed after seeding**
([stress-browser-webkit-1m-attempt1.json](results/stress-browser-webkit-1m-attempt1.json)):
100,000 conversations / 1,000,000 messages seeded in 10,000 bounded commits
in 1,570 s (637 messages/s); the integrity phase then failed with "Archive
reply deadline elapsed after dispatch": the whole-file `integrity_check`
outlived the storage client's default 60 s reply deadline, so the request
was reported as an unknown outcome while the worker kept scanning. This
was a product defect, not a harness one: the same operation ran at startup
through onboarding and the import controller, so opening a 1M-message
archive would have blocked or failed the same way. Fixed under
[ADR 0040](../decisions/0040-diagnostics-outcomes.md) amendment 3: the
explicit report carries a 600 s per-request deadline and records the
check's elapsed time, and the startup read verifies integrity only for files
up to 256 MiB, answering `unchecked` above that. The harness now measures
both reads.

**Second attempt (2026-09-13), failed at library paging**
([stress-browser-webkit-1m-attempt2.json](results/stress-browser-webkit-1m-attempt2.json)):
seeded in 1,481 s (675 messages/s); the explicit report's `integrity_check`
answered ok in 58.8 s over the 4,696 MB file (2,300,000 canonical records)
and the startup read answered `unchecked` in 38 ms, so the first finding is
fixed. The library's first page then took 25,437 ms against the 5 s bound
(twenty pages of 64 in 515.7 s, max 26.6 s per page). Cause: the library
view computes every thread's activity with a correlated subquery over the
whole `threadStates` set and sorts it, once per item (LIMIT 1 keyset loop),
so a 64-item page cost 64 scans of 100,000 threads. Fixed under
[ADR 0043](../decisions/0043-materialized-library-activity.md): schema 13
materializes one activity row per thread, kept by canonical triggers and
read through an ordered index in one statement per page; retained archives
at older schemas keep the previous query.

**Third attempt (2026-09-13), failed at the export snapshot**
([stress-browser-webkit-1m-attempt3.json](results/stress-browser-webkit-1m-attempt3.json)):
seeded in 1,557 s (642 messages/s); integrity ok in 58.2 s (4,713 MB file);
library first page 9 ms, twenty pages in 30 ms (was 25.4 s and 515.7 s);
cold reopen ready in 0.36 s with the first page in 42 ms; a second tab read
three pages in 79 ms. The portable export then failed with the same reply
deadline: its `snapshot` phase copied the whole 4.7 GB database inside one
advance step, which ADR 0010 had recorded as not bounded by `maxBytes`.
Fixed by the ADR 0010 amendment: the snapshot is copied in steps of at most
`maxBytes`, with the read transaction held across steps.

**Fourth attempt (2026-09-13), failed at the startup diagnostics read**
([stress-browser-webkit-1m-attempt4.json](results/stress-browser-webkit-1m-attempt4.json)):
seeded in 1,621 s (617 messages/s); the run then failed exactly 60 s after
the last seed commit, on the light `diagnostics` read (default reply
deadline), before the report was requested. In the third attempt the same
read answered in 38 ms, so something in the worker held the request for
over a minute this time. The harness now names the failing request and its
elapsed time and keeps the browser profile of a failed run, so the seeded
archive can be probed without reseeding; the cause is recorded with the
next attempt.

**Fifth attempt (2026-09-13), failed at the diagnostics report; cause found**
([stress-browser-webkit-1m-attempt5.json](results/stress-browser-webkit-1m-attempt5.json)):
seeded in 1,615 s (619 messages/s); the report request, sent with the 600 s
deadline, failed after 60,003 ms. Probing the kept profile
(`node packages/app/tests/browser/probe-archive.mjs <profile> <dist>`, which
logs the stack of every long timer the page arms) showed the 60 s timer
armed from the client's `call` with the *default* deadline: the harness's
own fault-injecting wrapper around `storage.request` forwarded three
arguments and dropped the per-request options. The product's clients pass
the options through (the Storage health panel calls the real client); the
harness wrapper now forwards them, and the probe on the same archive then
completed the report in 67.4 s (`integrity_check` 67.2 s over 4,942 MB)
under the 600 s deadline. The fourth attempt's stall was the same defect:
its light read succeeded and the report timed out at 60 s, reported by the
harness against the wrong step before the instrumentation.

**Sixth attempt (2026-09-13), failed at the restore's candidate import**
([stress-browser-webkit-1m-attempt6.json](results/stress-browser-webkit-1m-attempt6.json)):
seeded in 1,645 s (608 messages/s); integrity ok in 66.3 s; library first
page 9 ms; cold reopen 0.5 s; a second tab's three pages in 79 ms; the
portable export **completed**: 4,173,609,472 bytes (3,980 MB) produced in
10,214 s over 62,679 bounded steps (about 163 ms per step: the per-step
record budget of 128 and one statement per copied row dominate), streamed
out in 63,685 chunks in 243 s with the digest verified on disk. The WebKit
content process grew from about 1.7 GB to 5.3 GB resident over the export
(observed with `ps`, not measured by the harness). The restore then failed
on the reply deadline: after the container was received, the first
validation step copied the whole 4.7 GB received database into the
candidate pool in one advance, and the candidate's whole-file
`integrity_check` later in the same phase would have done the same. Both
are now stepped (ADR 0010 amendment: `BoundedFileCopier`; one table per
integrity step) and archive advances carry the 600 s deadline.

**Seventh attempt (2026-09-13), stopped during restore validation**: seeded
in 1,563 s; integrity ok in 56.5 s; the portable export completed in
9,338 s over 62,677 steps with the pre-batching bundle (the clean-copy
batching landed while it ran); the container streamed to disk and was
received by the stepped candidate import, and the validation then ran for
over three hours at full CPU with no progress visible (the harness reported
nothing between phases). The run was stopped with its profile and 4.17 GB
container kept; the harness now logs phase changes and progress every 5,000
steps, and a restore-only probe (`probe-restore.mjs`) replays the restore
over the kept archive. Suspected cause: the validator's root selection
(`parent_id IS NULL AND tin IS NULL`) had no index covering the visited
marker, so each of the 100,000 root picks rescanned the roots already
visited; `archive_validation_roots` now covers it. The probe (with that
index) streamed the container back in 302 s, copied the 4.17 GB candidate
in about four minutes over roughly 4,000 steps, reached record validation
after 7,984 steps at 530 s, and validated the 2,300,000 records' shapes and
edges at about 1,600 records per second (25,000 steps at 1,829 s). The
validator's later sub-phases (message topology, DFS intervals, a second
semantic pass and a coverage pass over every record, then 1,200,000
journal operations and receipts) cost several statements per unit and are
where the hours go; the job status now exposes the validator's sub-phase
(`validationPhase`) so the harness names it. The probe's total is recorded
when it finishes.

Assembled from the seventh attempt (seed, integrity, cold reopen, export),
the sixth (library paging, follower tab, export streaming) and the
restore-only probe over the seventh attempt's kept archive and container
after the validator rewrite
([stress-restore-probe-webkit-1m.json](results/stress-restore-probe-webkit-1m.json));
an eighth attempt with every fix in one bundle is recorded when it ends.

| Phase | WebKit, 100,000 conversations / 1,000,000 messages (2,300,000 canonical records, 4,712 MB database) |
| --- | --- |
| seed (10,000 bounded commits) | 1,499 s (667 messages/s) |
| startup read (file-size bound) / explicit integrity_check | 36 ms `unchecked` / 56.5 s ok |
| library first page / twenty pages of 64 | 9 ms / 30 ms |
| cold reopen: landing / first page | 0.3–0.5 s / 42 ms |
| follower tab: 3 pages | 79 ms |
| portable export: bytes / steps / produced | 3,980 MB (4,173,609,472 bytes) / 62,677 / 9,338 s (before the clean-copy batching) |
| export streamed out (63,685 chunks) | 243 s, digest verified on disk |
| restore: container received (4 MiB blocks) | 295 s |
| restore validation: steps / time | 71,596 / 5,349 s |
| — candidate import (4.17 GB, 1 MiB steps) + hash + schema + per-table integrity | 559 s |
| — records (shape, identity, edges) | 1,442 s (about 1,600 records/s) |
| — topology (set-based Kahn, 251 batches) | 55 s (was more than three hours per node) |
| — semantics pass | 1,278 s |
| — journal operations (1,200,000) | 782 s |
| — coverage pass | 1,211 s |
| — receipts, blob validation | 22 s |
| candidate | 2,300,000 canonical records at schema 13, validated and released, never activated |

## Not covered by this run

- **Attachments at 10–50 GB and quota exhaustion.** The reported quota on
  this machine is about 10 GB (Chromium) and 20 GB (WebKit), so a 10–50 GB
  attachment workload cannot be stored here; quota failure and recovery are
  covered at small scale by the storage proof's quota injection
  ([storage-proof.md](storage-proof.md)).
- **Interrupted writes** are covered by the storage proof (abrupt worker
  termination with an uncommitted transaction) rather than at this size.
- **Migration** at this size is not measured; the schema-8 candidate upgrade
  is qualified at small size in plan 09.
- **Lexical indexing** of 1M messages is not part of the run (the search
  scale proof measures 101k chunks); startup numbers are for the archive,
  not the derived index.
- Chromium at 1M messages: its per-step export cost makes the full run
  several hours; it is not run yet.
