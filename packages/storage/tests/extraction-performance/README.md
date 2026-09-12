# Dense extraction staging profile and digest compatibility

This diagnostic measures the shipped `ExtractionRepository.execute('stagePageText', …)` with the pinned SQLite WASM in Node's memory VFS. It uses real canonical migrations, canonical document/attachment lookup, `OperationClaimRegistry` with the real SQLite autocommit check, the shipped archive journal definition and its claim fences, real transactions, actual staging, publication and bounded cleanup. It does not substitute a native SQLite backend.

The narrow change reuses the canonical argument string already required for the immutable request snapshot when hashing the request envelope. It preserves the exact sorted `{"args":…,"operation":…}` bytes. Validation, deep cloning, stable operation/claim identity, map hashing, transaction boundaries, accounting, control reserves and limits remain unchanged. No accounting or registry-cache optimization is included.

## Captured workload and scope

Each of 100 pages contains 151,000 UTF-16 units in 1,000 text lines and 2,000 source/separator spans, coalesced into 38 control batches of at most 4,096 UTF-16 units. The deterministic text matches the dense workload generator in `perf/documents/generate_dense_fixtures.py`. The original `dense-100.pdf` bytes and manifest digest are checked. Span geometry is synthetic: width 600 is a diagnostic value, not a claim to reproduce PDF.js glyph widths. This run does not invoke PDF.js or prove parser event equivalence.

Only one bounded page's batches/maps are held by the harness. Timed staging excludes page admission, input generation, publication and cleanup. The reported publication time is separate and includes computing final text/map hashes. Each published page runs bounded cleanup outside the measured lane. Final checks establish 100 completed pages, 3,800 stage receipts and one durable claim per extraction receipt.

SQLite statement timings include the OO API's preparation, binding, execution and finalization. They exclude OPFS I/O, browser worker messages, managed-selection gates, PDF parsing and FTS page credit. Node's CPU sampling and SQL timers introduce overhead. This is a diagnostic pair, not a statistically controlled benchmark or browser performance claim.

## Retained comparison

Both captures used Node 22.23.1 on macOS arm64 and the same pinned WASM (`dd7c22431a3b8ad51ab5e6ed91065593574c34c5959d2efdef2f17484eedcb2c`). Only `worker/extraction/index.ts` differs among the captured source fingerprints. Both reports have `sourceStable: true`.

| Measurement | Before | Serialization reuse |
| --- | ---: | ---: |
| Capture UTC, 2026-09-09 | 10:48:54 | 10:49:45 |
| Total time for 3,800 stages | 2,859.25 ms | 2,757.02 ms |
| Stage p50 | 0.701 ms | 0.695 ms |
| Stage p95 | 1.044 ms | 1.010 ms |
| SQL calls per stage | 27 | 27 |
| Total SQL calls | 102,600 | 102,600 |
| Measured SQL time | 1,400.97 ms | 1,464.79 ms |
| Separate publication time | 1,081.00 ms | 1,136.31 ms |
| One-minute machine load | 3.94 | 4.10 |

The observed staging total is 3.6% lower in this pair. SQL/publication variability shows why it must not be read as a guaranteed speedup. CPU samples attributed to `canonicalJson`'s recursive `visit` fell from about 395 to 293 ms; its nested anonymous frame fell from 146 to 89 ms. These are sampled self times, not additional wall-clock totals. Hashing, boundary validation and map serialization remain necessary work.

The baseline accounts for the following SQL calls per batch:

| Work | Calls | Total across 3,800 stages |
| --- | ---: | ---: |
| Registry/schema guard inspection | 5 | 293.38 ms |
| Run reads, including two accounting charges | 3 | 183.84 ms |
| Archive accounting reads | 2 | 44.80 ms |
| Run/archive accounting updates | 4 | 98.07 ms |
| Claim lookup/insertion | 2 | 172.86 ms |
| Receipt lookup/insertion | 2 | 98.58 ms |
| BEGIN/COMMIT | 2 | 101.75 ms |
| Canonical document/attachment reads | 2 | 65.76 ms |
| Current document/page reads | 2 | 128.98 ms |
| Text/maps/checkpoint writes | 3 | 212.97 ms |

There is no full extraction-status or search-index count in this direct staging lane. The registry's repeated schema counts inspect a fixed set of named guards. The two accounting charges separately account for payload and receipt bytes. Coalescing them or caching registry readiness are separate candidates requiring their own rollback, quota, schema-change and missing-guard proofs; neither was implemented.

## Compatibility acceptance

`serialization.test.ts` has four passing tests against actual SQLite WASM:

- All eight write kinds execute, retain the pre-change algorithm's exact request digest, and replay unchanged receipts before and after SQLite close/reopen. Nested key ordering, negative zero, fractional/exponent values, surrogate pairs, NUL, escaped controls, quotes, backslashes and Unicode combining characters are covered. Publication covers both legacy omission and current layout metadata.
- Actual frozen version-1 stage/publication receipts retain their original digests and results; changed payloads still conflict. The immutable v1 bundle hash is verified. Full v1 database upgrade/preservation is tested separately by the layout suite.
- A caller mutates text, run identity and nested span geometry after the snapshot and before the first receipt lookup. Persisted content, maps and digest still describe the original request; original-argument replay succeeds.
- Invalid numeric values, unknown keys and oversized control data fail before new claims or staged text.

The compatibility fixture uses the existing extraction-search claim adapter; the profiling harness and the operation-claims suite exercise the actual production registry. All requested regressions passed at the optimized source: 21 extraction tests, 10 layout/upgrade tests and 21 operation-claim tests, plus these four compatibility tests. Targeted and root TypeScript checks passed. This includes actual SQLite `FULL` rollback, frozen old-reader refusal and legacy receipt replay; it does not newly qualify browser-enforced quota or OPFS durability.

## Reproduce and inspect

```sh
npx tsc --noEmit -p packages/storage/tests/extraction-performance/tsconfig.json
node packages/storage/tests/extraction-performance/run.mjs
QUIXI_STAGE_PROFILE_CAPTURE=optimized node --experimental-transform-types packages/storage/tests/extraction-performance/profile.ts
npm run test:storage:extraction
npm run test:storage:extraction-layout
npm run test:storage:operation-claims
```

The fixture files and pinned SQLite build must already be available. `QUIXI_STAGE_PROFILE_PAGES` accepts 1, 10 or 100; default is 100. The capture label accepts `baseline` or `optimized` and selects output filenames only—it does not change the implementation. Use an isolated checkout of the retained baseline source to rerun the old implementation; never replace a live worker during another acceptance capture.

[baseline.json](results/baseline.json) and [optimized.json](results/optimized.json) retain timings, selected runtime/dependency hashes, machine context and CPU summaries. [baseline-extraction-index.ts.txt](results/baseline-extraction-index.ts.txt) is the exact measured pre-change source (`be7a6a8981271619a0f3d37daa61594da489feb5b76a193427b7d6dfa0e69ecc`). The optimized extraction source is `e0175db4d0a20b182d7c31bda46e95dd5eb15e82c60e67cf09ad6c4d5779b92d`.

Raw profiles are retained as [baseline.cpuprofile.gz](results/baseline.cpuprofile.gz) and [optimized.cpuprofile.gz](results/optimized.cpuprofile.gz), with compressed and uncompressed hashes in the corresponding report. Decompress a copy and open it in a CPU-profile viewer. Summary samples include only stacks under `stageMeasuredBatches`; GC/out-of-stack samples are omitted. CPU line numbers refer to Node-transformed TypeScript and should be matched by function/source URL rather than treated as exact original-file line locations.

[serialization.json](results/serialization.json) and [serialization.tap](results/serialization.tap) retain focused acceptance. The existing [extraction](../extraction/results/repository-wasm.json), [layout](../extraction-layout/results/repository-wasm.json) and [claim](../operation-claims/results/registry-wasm.json) reports hold the regression results and their own source fingerprints. These files are revision-scoped evidence and may be superseded by later runs.
