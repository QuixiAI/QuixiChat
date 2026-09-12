# Browser SQLite staging diagnostic

This optional, local diagnostic measures actual managed browser/OPFS execution. It addresses the gap between private Node repository stage timings and browser staging latency. It neither changes production source files nor substitutes another SQLite backend.

```sh
node --test perf/documents/sql/observer.test.mjs
npx tsc --noEmit -p perf/documents/tsconfig.json
QUIXI_TEST_BROWSERS=chromium QUIXI_PERF_SQL=on QUIXI_PERF_CASES=dense-1,dense-10 QUIXI_PERF_REPORT=dense-sql-small node perf/documents/run.mjs
node perf/documents/sql/summarize.mjs dense-sql-small
```

SQL mode requires Chromium, heap/target observation enabled, GC disabled, and explicit dense cases. It is an instrumented diagnostic, not ordinary throughput. It uses the same original fixture hashes, real persistence workflow, full-synchronous SQLite/OPFS transactions, early FTS credit and foreground probes. The captured source includes the root's combined cache/digest optimizations; older no-GC timing reports are not an identical-runtime control for this diagnostic.

## Exact build hook

`pins.json` freezes two reviewed production source hashes. The worker-only Vite plugin verifies each complete input hash and a single exact replacement anchor; any drift fails the build. It adds one initializer continuation to `sqlite-module.ts` and wraps the normal request's existing entire `fenced(...)` call in `archive-runtime.ts`. It does not edit SQL, transaction boundaries, arguments, bindings, returned values, error objects, isolation/durability settings or the ordinary app's bundle. The virtual observer module is included only in the opt-in diagnostic worker build.

The current official [Vite worker plugin documentation](https://vite.dev/config/worker-options#worker-plugins) requires build worker plugins in `worker.plugins`, using fresh instances. The [plugin transform API](https://vite.dev/guide/api-plugin#transform) supports the source transform; this harness uses a pre-transform hook. Both sources were checked 2026-09-09; the installed Vite is 8.2.2. The report records input/transformed/runtime hashes, the actual transformed source artifacts and all built asset hashes. Repeated identical transforms from separate worker builds are retained as bounded build evidence.

The initialized SQLite `oo1.DB` prototype is wrapped for `exec`, `selectValue(s)`, `selectArray(s)` and `selectObject(s)`. The pinned SQLite source routes `selectValue` directly through prepare/bind/step/finalize, bypassing `exec`, so an exec-only observer would miss schema checks. Methods which call another observed helper are counted only at the outer level. The [official SQLite OO1 API](https://sqlite.org/wasm/doc/trunk/api-oo1.md) and captured exact `sqlite3.mjs` bytes identify the measured interface.

Wrappers forward the exact `this` and argument references with `Reflect.apply`, return the exact result, and rethrow the same error. Tests verify those properties, transaction order, nested suppression, static overlap labels, and absence of synthetic private strings from snapshots. These tests qualify instrumentation mechanics; actual browser evidence is the primary execution proof.

## Captured data and limits

Only fixed labels and numeric aggregates are retained: operation name from an allowlist; static archive/selection/other database role; adapter method; SQL category; count, total/min/max time, error count and a 16-bin histogram. SQL classification examines at most 2,048 characters transiently, before the timed call. It never stores SQL text, bindings, operation arguments/IDs, arbitrary database names, results, or error messages. Trigger work remains included in the invoking adapter call; this is not a statement-level trace inside SQLite.

The map has at most 512 category rows plus one overflow bucket, at most 32 operation summaries and at most 8 tracked overlapping scopes. Unknown operation labels collapse to `other`; overlapping scopes use `overlap`. No per-call timing arrays are added. Snapshots are bounded to 512 KiB. A completed, unambiguous diagnostic requires zero active/overlap/overflow counts. Counters reset only after source setup, while no request scope is active.

The identified archive worker is evaluated only after setup and at extraction completion through the existing local CDP channel. No startup-worker JavaScript evaluation, new production request route or database table is introduced. Setup aggregates are retained separately; extraction aggregates include the foreground baseline reads, workflow and short post-extraction observation.

Synchronous adapter time includes JavaScript binding/result conversion, SQLite/WASM work and blocking OPFS/VFS IO. It does not isolate SQL CPU, journal flushes or fsync. The fenced scope includes selection guard acquisition and effect execution. Its residual after adapter time includes WebLocks, VFS/database open-close/unpause work, JavaScript validation/digest/serialization and observer overhead. The client-minus-scope difference includes queue/protocol/scheduling delays; it cannot be assigned to one cause by subtraction. Unattributed SQL can include post-drain maintenance or other work outside the wrapped normal request. No latency threshold or stable regression claim follows from these single captures.

## Actual small capture

[The report](../results/dense-sql-small.json) finished at 2026-09-09T11:00:48.195Z, both cases passed with `sourceStable:true`. Both pinned transforms were applied. Each snapshot contains 215 category rows, zero nested/overlap/overflow events and no observer errors. Original output remains 151,000 characters per page with 2,000 spans and 38 staging batches; canonical/sync counts stay unchanged and both PDF workers terminate.

| Workload | Stage calls | Client stage total, ms | Full fenced stage total, ms | SQLite adapter total, ms | Archive COMMIT total, ms | Selection SQL total, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 page | 38 | 343.1 | 299.1 | 190.5 | 97.0 | 10.0 |
| 10 pages | 380 | 4,314.9 | 3,671.0 | 2,281.2 | 1,224.1 | 107.5 |

For 10 pages, mean stage latency is 11.35 ms at the client, 9.66 ms in the fenced scope and 6.00 ms inside timed adapter methods. Archive `COMMIT` averages 3.22 ms per stage—53.7% of adapter time and 33.3% of fenced time. Claim insertion totals 461.4 ms (1.21 ms/stage), text insertion 148.3 ms, and map insertion 60.3 ms. The claim insertion includes its triggers and write-side costs; this capture does not isolate a journal-header flush.

Archive schema reads total 47.8 ms across 1,900 calls (five per stage, 0.126 ms/stage). All selection-catalog SQL within stage totals 107.5 ms (0.283 ms/stage, 2.9% of fenced time). **That does not bound the full selection guard cost**: its lock/database/VFS work may occupy the 1,389.8 ms fenced residual (3.66 ms/stage). The client-minus-scope difference is 643.9 ms (1.69 ms/stage). Neither residual is labeled serialization CPU.

Across the whole 10-page observation, unattributed SQL totals 2,119.4 ms, including 727 archive commits totaling 639.6 ms and 9,171 extraction reads totaling 746.9 ms. The pinned runtime performs cleanup/producer reconciliation/search work after draining requests, consistent with a meaningful maintenance cost. This grouping does not prove that every unattributed call belongs to maintenance or attribute all of its time to staging waits.

The evidence prioritizes investigating durable archive write/commit costs and the non-SQL selection/maintenance path before assuming schema checks dominate. Preserve full durability and exact per-operation receipt semantics while measuring any change. The next discriminating hook could time VFS/database lifecycle and selection lock waits separately; current aggregate residual alone is insufficient. A 100-page or WebKit SQL-attribution claim is not made here.

[The bounded summary](../results/dense-sql-small-summary.json) contains report/tool hashes, stage rows and all fixed-category groups. Report-named source snapshots retain the executed harness/plugin/runtime, and the two transformed production modules are separate artifacts. No production files were changed by this task.
