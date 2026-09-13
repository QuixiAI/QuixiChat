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

FULL_RUN_RESULT

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
