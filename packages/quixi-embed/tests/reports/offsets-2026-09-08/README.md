# Original-source offsets and CPU 1.0.2 evidence

The standalone owned C tokenizer now returns complete original UTF-8 and UTF-16
token ranges, with separate source, query-prefix and synthetic-framing origins.
The [API contract](../../../src/TOKEN_OFFSETS.md) defines normalization provenance,
capacity failures, memory accounting and later chunker integration. CPU 1.0.2 is
frozen; model/tokenizer format v1 and the 1.0.0/1.0.1 distributions remain intact.
This change does not integrate a model-aware chunker into product storage.

## Correctness and bounds

| Evidence | Coverage and result |
| --- | --- |
| [Native focused offsets](token-offset-native.json) | 870 cases; exact IDs, byte/UTF-16 ranges, origins and required count on rejection |
| [Native exhaustive offsets](token-offset-native-exhaustive.json) | 2,412 grouped cases covering 154,295 distinct Unicode scalars, alone and inside words, in both roles |
| [Production scalar/SIMD offsets](token-offset-wasm.json) | All 870 cases on both routes; legacy tokenize/inspect compatibility, input/capacity bounds and disposal |
| [Production scalar/SIMD exhaustive offsets](token-offset-wasm-exhaustive.json) | All 2,412 grouped cases on both routes |
| [Native memory safety](token-offset-safety.json) | AddressSanitizer/UndefinedBehaviorSanitizer, output canaries, invalid UTF-8/arguments, maximum input/capacity and complete free lifecycle |
| [Pinned compiler stack](token-offset-stack.json) | 8,560-byte sum of tokenizer frames on the offset path, excluding caller/libc frames; raw [stack usage](tokenizer-offset-stack.su) retained |
| [Fully provisioned offset CI](token-offset-ci.json) | All 22 commands passed; complete [log](offset-provisioned-ci.log) retained |

Exhaustive selection covers 139,248 deleted scalars, 14,286 normalization mappings,
726 punctuation scalars and 44 CJK boundary scalars; these sets overlap. Frozen
artifact tables select coverage, while the pinned upstream tokenizer supplies
expected IDs and normalization independently of the C implementation. Original
code-point boundaries are converted independently into UTF-8 and UTF-16 ranges.
The [generator](../../../reference/generate_offset_fixtures.py) reproduces the
tracked focused fixtures byte-for-byte and writes the larger exhaustive fixture
under ignored `build/`; its SHA-256 is recorded in both exhaustive reports.

There are 28 hand-specified contributor cases within the 870 focused cases.
Sixteen deliberately differ from pinned tokenizers 0.21.0 offset metadata, while
all IDs and normalization agree. For `a\u1dce\u1b44`, upstream reports scalar span
`[0,2)` after removing U+1DCE, excluding the retained U+1B44 contributor at original
position 2. The owned API returns contributor bounds UTF-16 `[0,3)` / UTF-8
`[0,7)`. The [manual authority](../../token-offset-contributor-cases.json) and
[archived comparison](upstream-alignment-observation.json) retain the exact cases.
These tests establish the documented contributor contract, not universal parity
with upstream offset metadata.

| Maximum-capacity resource | Evidence |
| --- | ---: |
| Input ceiling | 1,048,576 UTF-8 bytes |
| Token record capacity | 65,536, including framing/prefix |
| Temporary C records | 1,572,864 bytes; released after success and rejection |
| Returned typed-array data | 1,376,256 bytes; caller owns retention |
| Explicit provenance stack array | 6,400 bytes |
| Standalone WASM linear memory | Fixed 16,777,216 bytes in tested loops |

Each Node route ran 128 maximum-capacity repetitions; each browser route ran 32.
The 1 MiB punctuation input rejected with exact required counts 1,048,578 for
documents and 1,048,586 for queries, returning no partial arrays. Successful
1 MiB long-unknown-word cases preserved the final byte and UTF-16 positions for
ASCII and astral input. Bounds are checked before capacity arithmetic and writes;
the C offset operation performs no heap allocation. Reported memory excludes
caller-retained inputs/results, JavaScript object overhead and OS RSS.

## Actual browser workers

| Engine | Scalar | SIMD |
| --- | --- | --- |
| Chromium 153.0.8010.12 | [Pass](token-offset-chromium-scalar.json) | [Pass](token-offset-chromium-simd.json) |
| Firefox 155.0 | [Pass](token-offset-firefox-scalar.json) | [Pass](token-offset-firefox-simd.json) |
| WebKit 26.6 | [Pass](token-offset-webkit-scalar.json) | [Pass](token-offset-webkit-simd.json) |

Every worker ran all 870 cases plus the maximum-input/capacity and ownership
checks using actual production WASM. Requests for model weights were blocked and
treated as failures; only the WASM module, standalone vocabulary/Unicode artifact
and test fixtures were fetched. Reports retain actual asset requests, module
fingerprints, browser versions and renderer heartbeat observations. These runs
used Apple M5 Max/macOS 26.6.2 with Node 22.23.1; they do not establish desktop
WebView compatibility or new GPU-family coverage.

## Numerical and scheduler compatibility

| Evidence | Result |
| --- | --- |
| [Native 159-case parity](offset-native-parity.json) | Pass; maximum absolute error 8.58306884765625e-6 |
| [Scalar WASM 159-case parity](offset-scalar-parity.json) | Pass; maximum absolute error 8.58306884765625e-6 |
| [SIMD WASM 159-case parity](offset-simd-parity.json) | Pass; maximum absolute error 8.58306884765625e-6 |
| [Scalar/SIMD comparison](offset-simd-scalar-parity.json) | Exact identity across every saved candidate case |
| [CPU provisioning CI](ci-simd-report.json) | Kernel, distribution, production API, retained memory and legacy browser checks passed |
| [Strict preflight](token-preflight-report.json) | Existing 397-case admission/digest checks passed with CPU 1.0.2 |
| [Scheduler compatibility CI](scheduler-ci-report.json) | All 21 commands passed, including 12 browser CPU/GPU/loss routes using CPU 1.0.2; [log](offset-scheduler-ci.log) retained |

Numerical candidates were freshly generated from current diagnostic native,
scalar and SIMD builds. Their manifests and build fingerprints are archived
separately from production modules. The full numerical commands were run
individually; the archived 22-command wrapper used its default mode, not `--full`.
Encoder arithmetic and GPU sources did not change. Existing scheduler tests
exercise actual Apple GPU FP32/half execution and loss fallback with the updated
CPU tokenizer; they do not replace wider plan 19 hardware gates.

The [production distribution](cpu-distribution.json) contains the 44,805-byte
scalar module (`e477d3e35b6e83c39e206e76079a4d5136a227711a0124b64bf885f3165cee65`)
and 44,657-byte SIMD module
(`d07bbc26c3f35731d7e2c6885405205a64852f40f9d7c5878c6efe77e8f9b198`).
[Distribution integrity](distribution-integrity.json) verifies the retained
1.0.0, 1.0.1 and new 1.0.2 module bytes against their frozen manifests.

## Reproduction and integration limits

From the repository root after `npm ci`:

```sh
python3 packages/quixi-embed/native/offset_ci.py
python3 packages/quixi-embed/native/offset_ci.py --skip-provision
python3 packages/quixi-embed/native/offset_ci.py --full
python3 packages/quixi-embed/native/scheduler_ci.py --skip-provision --gpu
```

The first command provisions public model/tokenizer assets, the pinned reference
environment and browser binaries. The second requires those existing verified
inputs. Both require clang and Docker for native safety and pinned Emscripten
stack checks. `--full` additionally regenerates all 159 numerical candidates per
CPU route. The wrapper replaces stale success at startup and records the failing
command/status on errors; two tests cover stale-report and process-launch failure.
See [native provisioning](../../../native/README.md) for host prerequisites and
the separate verified Linux CPU dependency lock. Actual offset replay here was
on macOS; Linux provisioning support is not a claim that this archive contains a
Linux offset/browser run.

The [conditions](conditions.json) retain source hashes and shared-host conditions.
Concurrent development builds/tests were present during numerical generation;
elapsed times and heartbeat observations are not controlled release benchmarks.
Windows/Linux device, desktop WebView and broader GPU-family gates remain open.

Later chunker integration must preserve uncovered source gaps, account for
overlapping contributor ranges and avoid splitting surrogate pairs. It must
re-inspect each final candidate's exact embedding text, including any context
prefix, for the 512-token and scheduler byte bounds. Offsets alone do not prove
that a source slice fits: slicing changes WordPiece segmentation. Structural/FTS
chunking remains independent of model availability, and durable publication stays
with the storage owner.

[Checksums](checksums.json) cover every file in this archive except the checksum
index itself. Frozen source fixtures and binary distributions remain at their
package paths, with their identities also recorded in these reports.
