# Browser-enforced OPFS quota recovery

`tests/e2e/storage-quota.spec.ts` exercises [plan 01](../../docs/plans/01_prove_universal_storage.md)'s actual browser-quota failure case using the unchanged Storage Worker → SQLite WASM → OPFS path. It is separate from the database `max_page_count`/`SQLITE_FULL` probe.

## Method and bounds

The test uses a disposable persistent Chromium profile from `fixtures.ts`. After committing a sentinel record it reads the origin's browser-accounted usage with `Storage.getUsageAndQuota` and applies a quota only 512 KiB higher through [CDP `Storage.overrideQuotaForOrigin`](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-overrideQuotaForOrigin). The protocol specifies byte units and resetting the override by omitting `quotaSize`.

The overridden quota must be below 16 MiB. At most 64 records of 65,536 ASCII characters are attempted serially: less than or equal to 4 MiB of synthetic input, stopping at the first rejection. This cannot exhaust the host disk. Chromium's access-handle reservations count toward origin usage, so the initial six-file SAH pool consumes about 6 MiB of accounted quota even when actual database content is small.

Transparent wrappers around the real worker's `FileSystemSyncAccessHandle.write` and `truncate` record exceptions and rethrow the same exception without changing behavior. The test requires an actual browser `QuotaExceededError`; a generic SQL or RPC failure alone cannot satisfy the assertion. SQLite page limits are not modified.

The override is reset in `finally`. The client then closes and the page reloads, creating a new Storage Worker and reopening the database. Assertions require integrity `ok`, exact IDs and full text of every acknowledged committed record, absence of the failed record, matching operation-log count, and correct FTS results. A further write must succeed after recovery. The test observes rollback from reopened state; it never infers rollback merely from the failed request.

## Measured result — 2026-09-08

Chromium 153.0.8010.12 on macOS ARM64, SQLite 3.53.4, sqlite-vec v0.1.9:

| Observation | Result |
| --- | --- |
| Browser-accounted initial usage | 6,293,180–6,293,182 bytes across fresh profiles |
| Overridden quota | 6,817,468–6,817,470 bytes |
| Writes accepted under override | Six 65,536-character records |
| First rejected record | `pressure-006` |
| Actual browser failure | `QuotaExceededError`: `FileSystemSyncAccessHandle.write` reported no space available |
| SQLite surface error | `SQLITE_IOERR`, result code 10; worker reports `DATABASE_ERROR` |
| Reopened database | Integrity `ok`; sentinel plus six committed records, seven matching operations |
| Failed write and FTS | Failed record absent; retained full text and FTS assertions pass |
| Further write after restoration | Passed |

The origin usage need not reach the override exactly: Chromium may reject an additional access-handle reservation before it would exceed the quota. The test validates the real write exception rather than relying on an equality of accounting values.

WebKit is explicitly skipped because this test depends on a Chromium CDP quota control with no equivalent WebKit control. This does not claim WebKit quota-exhaustion coverage, physical-disk exhaustion, automatic browser eviction, or every possible transaction interruption point.

## Reproduce

First serve a built application on an unused port:

```sh
npx vite preview apps/web --host 127.0.0.1 --port 4181 --strictPort
```

Then run in a separate terminal:

```sh
QUIXI_TEST_BASE_URL=http://127.0.0.1:4181 \
QUIXI_TEST_OUTPUT_DIR=playwright-report/quota \
npx playwright test tests/e2e/storage-quota.spec.ts --workers=1
```

The JSON reporter contains the `browser-quota-evidence` attachment: quota state before/during/after, accepted and failed IDs, original browser exceptions, worker errors, reopened diagnostics, and recovered record summaries. Disposable browser profiles are removed by fixture cleanup. Use a separate output root from other concurrent Playwright runs because Playwright cleans its output directory at startup.
