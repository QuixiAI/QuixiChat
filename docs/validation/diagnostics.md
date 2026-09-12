# Diagnostics report and derived-index actions

Plan [23](../plans/23_build_diagnostics_and_recovery.md), product §100/§101,
[ADR 0040](../decisions/0040-diagnostics-outcomes.md). Last run 2026-09-12 on
macOS 25.6.0 (arm64), Node v22.23.1, Playwright Chromium and WebKit, SQLite
WASM 3.53.4 with sqlite-vec, canonical schema 12.

## What is proven

**Classification (Node, real SQLite WASM)** — `npm run test:storage:diagnostics`,
12 tests, `packages/storage/tests/diagnostics/diagnose.test.ts`:

- the bundled build reports FTS5 and sqlite-vec available;
- a healthy archive reports every §100 check `ok`, in product order, with a
  report that contains no filename;
- a referenced file absent from the catalog or from storage is
  `missing_data`, with integrity and the search index still `ok`;
- a stored file whose size differs from its record is `attention`;
- the reference check is bounded (records and files) and says so;
- a retained derived-index failure, or a failed index status, is
  `rebuildable`; failed sources are `attention`;
- absent FTS5, sqlite-vec or chunk tokenizer are `unsupported` (stated
  inputs: this build has all three, so these cases are not produced by a
  real host);
- persistence granted, refused and unreported are `ok`, `attention`, `unknown`;
- unreferenced b-tree pages (an index whose `sqlite_master` row was removed
  through `writable_schema`, reopened) are reported by `integrity_check` as
  `corruption` while the schema check stays `ok`; a dropped canonical table
  is schema `corruption`; a malformed reference in a record is `corruption`.

**Application (Chromium and WebKit)** — `npm run test:app:storage-health:browser`,
12 checks per engine, [retained report](results/blob-inventory-ui-macos.json).
On the blob-inventory fixture archive (one referenced file deleted, one
catalog row deleted, one file shortened, orphans, staged and unrecognized
entries):

| Step | Report |
| --- | --- |
| Seeded archive | integrity, schema, FTS5, sqlite-vec, ownership, search index, semantic index `ok`; persistence `attention` (headless profiles are not persisted); attachment references `missing_data` (102 references, 6 distinct digests, 1 file missing, 1 without metadata, 1 size mismatch) |
| Derived ledger fault, owner replaced | search index and semantic index `rebuildable`; integrity and schema `ok`; references still `missing_data` |
| Rebuild search index | both derived checks back to `ok`; index reaches `ready`; canonical record and sync-operation counts unchanged |
| Delete semantic index | notice and refreshed report; semantic state `disabled`; Rebuild semantic index disabled with its reason (no model on this host) |
| Database corruption fault, owner replaced | integrity `corruption` (1 message: "Page 155: never used"); schema, search index `ok`; references `missing_data` |
| Fingerprint | canonical rows, sync and blob operation records, catalog, transfers and every stored file byte equal the baseline taken before the scan |

The report's JSON contains none of the fixture's private names, original
content or `.txt` filenames. The Storage health section's narrow-layout
screenshots ([Chromium](results/storage-health-chromium-mobile.png),
[WebKit](results/storage-health-webkit-mobile.png)) are retained from the
same run.

**Controller (Node)** — `npm run test:app:storage-health` also runs
`packages/app/tests/diagnostics/report-controller.test.ts` (4 tests): one
report per run, a fresh operation id per rebuild with the epoch described,
boundary errors as plain messages with the last report kept, invalidation
dropping late results, and disposal.

## Inference self-test (product §100 second list, §101 "run QuixiEmbed self-test")

**Classification (Node)** — `npm run test:embed:self-test`, 7 tests,
`packages/quixi-embed/tests/self-test.mjs`, with substituted encoders: the
three frozen cases are unit vectors from the pinned golden manifest; a
healthy CPU host reports model, tokenizer, scalar and SIMD `ok` and a refused
WebGPU adapter as `attention` with the reason; a digest mismatch is
`corruption` and skips the golden runs; a tokenizer drifting by one id is
`corruption`; CPU vectors outside the parity tolerance or not unit length are
`corruption` while 5e-6 drift is `ok`; no WebAssembly SIMD is `unsupported`;
WebGPU absent is `unsupported`, present but not attempted is `attention`, an
active FP16 route within its bound is `ok`, an FP32 route drifting 2e-3 is
`corruption`, and a route lost mid-test is `attention` naming what served.

**Application (Chromium and WebKit)** — the [semantic proof](semantic-search.md)
(`npm run test:app:semantic:browser`) now runs the Storage health
"Run inference self-test" right after enrolment with the real model and
records every check's outcome and measurements; see the table below for the
last run. The model hash check re-reads the artifact from its OPFS copy and
re-hashes it; the reported digest equals the enrolment's source hash.

| Check | Chromium (WASM SIMD · CPU route) | WebKit (WebGPU · FP32 route) |
| --- | --- | --- |
| Model hash | `ok`, re-read from cache, 90,785,583 bytes, digest equals the lock | same |
| Tokenizer | `ok`, 3 cases, exact ids | same |
| Scalar golden | `ok`, min cosine 1.0, max \|Δ\| 1.09e-7 (bound 2e-5) | same |
| WASM SIMD backend | `ok`, min cosine 1.0, max \|Δ\| 1.09e-7 | same |
| WebGPU backend | `unsupported`: no WebGPU adapter in headless Chromium | `ok`, live `webgpu-fp32` route, max \|Δ\| 8.9e-8 (bound 1e-3) |
| Elapsed | 1.17 s | 1.19 s |

Retained run: [semantic-search-app-macos.json](results/semantic-search-app-macos.json).

## Exportable report (product §100, plan 23)

**Builder (Node)** — `npm run test:app:storage-health` also runs
`packages/app/tests/diagnostics/export.test.ts` (3 tests): the file is built
from an allow-list (a planted secret-looking field and planted payload text
never reach the bytes, long measurements are clipped, absent sections carry a
reason), the name is `quixi-diagnostics-<UTC time>.json`, and saving stages
every byte through the host's `file_save` transfer with the digest, then
saves and releases.

**Application (Chromium and WebKit)** — the storage-health proof (13 checks
per engine, [retained](results/blob-inventory-ui-macos.json)) clicks "Save
diagnostics report" after the seeded run, captures the browser download,
parses it and checks: only the allow-listed top-level keys, storage checks
equal to the panel, the inference section absent with a reason (no model on
that host), and none of the fixture's private names, original content or
`.txt` filenames in the bytes (about 3.7 KB). The semantic proof saves the
file after the inference self-test and checks that its five inference checks
equal the self-test's and that the seeded conversation text is absent.
Headless engines cancel the native save picker, so the proofs disable it and
take the download path, as the shared-app proof does.

## Limits

- The reference check is bounded (newest 4,096 referencing records, first 64
  distinct digests probed for a file). It reports `complete: false` beyond
  that and defers to the storage scan; it does not hash file contents.
- `unsupported` outcomes are proven by classification only; no host in the
  matrix lacks FTS5, sqlite-vec or the tokenizer.
- The corruption fixture is a real inconsistency SQLite detects, not a
  torn write; a database that fails to open is handled by the startup
  outcome ([ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md)),
  not by this report.
- Semantic rebuild (re-embedding) is exercised by the semantic proof, not
  here; on this fixture host it is disabled because no model is provided.
- The inference self-test
  proves the routes present on the two Playwright engines; hardware WebGPU
  adapters on other machines remain plan 19/21/24 gates.
