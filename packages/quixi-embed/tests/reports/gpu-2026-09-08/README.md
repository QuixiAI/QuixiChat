# WebGPU hardware evidence — 2026-09-08

The final [115-command hardware suite](./gpu-ci-report.json) passed with existing verified assets on Apple M5 Max/macOS 26.5.2 arm64, Chromium 153.0.8010.12/Metal and WebKit 26.6. It verifies the versioned source bundle, tuning/cache rules, strict TypeScript, independent kernels, public production lifecycle and every retained projection/attention combination. The [earlier 103-command pass](./gpu-ci-initial-passed.json) is preserved. One expanded replay ended when the Chromium browser closed during a graph case; [that failed run](./gpu-ci-browser-closure-failed.json) was retained and the terminal failure was replayed successfully. The evidence does not establish why the browser closed, and no automatic green retry is built into CI.

## Numerical gates

- Each engine passed 83 independent FP64-oracle kernel cases on baseline, tiled and half routes. The cases cover all fixed projection widths, ragged masks, softmax limits, tile boundaries, fused attention, normalization, pooling and GELU.
- Seven combinations (baseline/tiled/half with baseline or fused attention, plus auto/fused) each passed all 159 original cases and 30 supplemental tile-boundary cases in both engines: 2,646 complete graph cases. IDs/masks, all requested hidden stages, pooled values and final vectors are compared against frozen independent upstream outputs.
- Across retained FP32 routes, the largest hidden-stage error is 8.7022781e-6; the smallest final cosine is above 0.99999999999978. FP16 maximum hidden error is 0.005866051 and minimum final cosine 0.9999997477. All pass their distinct frozen FP32/FP16 tolerances; hidden error is not final-vector error.
- Original and supplemental manifests remain independent of GPU execution. The final candidates record the full model, shader and runtime distribution identity.

## Retrieval and complete corpus work

Every forced retained combination independently embedded 659 chunks and 18 queries and reproduced identical top-ten document rankings and the frozen recall@5/recall@10/MRR. This is a small synthetic relevance corpus, not a large-index or compression approval.

| Engine | Projection | Attention | Maximum vector error | Top-ten changes |
|---|---|---|---:|---:|
| chromium | [baseline](./gpu-final-chromium-baseline-baseline-retrieval.json) | baseline | 2.38418579e-07 | 0 |
| chromium | [tiled](./gpu-final-chromium-tiled-baseline-retrieval.json) | baseline | 1.49011612e-07 | 0 |
| chromium | [half](./gpu-final-chromium-half-baseline-retrieval.json) | baseline | 8.11070204e-05 | 0 |
| chromium | [baseline](./gpu-final-chromium-baseline-fused-retrieval.json) | fused | 2.38418579e-07 | 0 |
| chromium | [tiled](./gpu-final-chromium-tiled-fused-retrieval.json) | fused | 1.49011612e-07 | 0 |
| chromium | [auto](./gpu-final-chromium-auto-fused-retrieval.json) | fused | 1.49011612e-07 | 0 |
| chromium | [half](./gpu-final-chromium-half-fused-retrieval.json) | fused | 8.11070204e-05 | 0 |
| webkit | [baseline](./gpu-final-webkit-baseline-baseline-retrieval.json) | baseline | 2.38418579e-07 | 0 |
| webkit | [tiled](./gpu-final-webkit-tiled-baseline-retrieval.json) | baseline | 1.49011612e-07 | 0 |
| webkit | [half](./gpu-final-webkit-half-baseline-retrieval.json) | baseline | 8.11070204e-05 | 0 |
| webkit | [baseline](./gpu-final-webkit-baseline-fused-retrieval.json) | fused | 2.38418579e-07 | 0 |
| webkit | [tiled](./gpu-final-webkit-tiled-fused-retrieval.json) | fused | 1.49011612e-07 | 0 |
| webkit | [auto](./gpu-final-webkit-auto-fused-retrieval.json) | fused | 1.49011612e-07 | 0 |
| webkit | [half](./gpu-final-webkit-half-fused-retrieval.json) | fused | 8.11070204e-05 | 0 |

The raw retrieval reports also retain each real production query/batch timing and initialization time. The following totals are single corpus passes, not 30-sample latency estimates or scheduler benchmarks. Driver caches were not cleared; assets were fetched before instance initialization.

| Engine | Route | Initialization ms | Sum of 18 query execution ms | Sum of 659-chunk backfill execution ms |
|---|---|---:|---:|---:|
| chromium | auto/fused | 566.17 | 31.50 | 338.60 |
| chromium | half/fused | 380.42 | 53.10 | 334.20 |
| webkit | auto/fused | 483.87 | 35.00 | 645.00 |
| webkit | half/fused | 424.29 | 59.00 | 626.00 |

## Resources, availability and failure

Both lifecycle reports observe real GPUBuffer creation/destruction across 500 production jobs, queue-busy rejection, cached tuning, device.destroy loss during execution, pending disposal, contained observer exceptions and subsequent actual WASM SIMD inference. The public factory has no diagnostic capture method. Simulated unavailable adapters/features and an injected third-allocation failure test admission/error paths; they are not claims of real hardware OOM.

At configured batch 4/max 512 with auto/fused, each engine observes 17 allocations, peak 121,780,240 bytes, no allocation during steady inference, and 17 destructions/zero owned live bytes after loss. Full production B32/T512 reserves 342,181,904 bytes for auto/fused, or 387,312,656 bytes for half/fused. The C tokenizer starts with 16 MiB of WASM linear memory, separately from GPU allocation accounting; its compiled growth ceiling is 512 MiB. Model asset/copy buffers and driver-private allocations are outside these GPU counts. Full-stage diagnostic tests intentionally reserve more memory and must not be used as production footprint estimates.

Hardware probes reject software/fallback adapters. `gpu-initial-adapters.json` preserves the initial unavailable default headless Chromium/Firefox observations and the working Apple adapters. Final standalone probes record explicit launch flags, browser versions, features and limits. Enabling optional FP16 requires `shader-f16`; subgroup normalization remains excluded from the public API because its measured experiment regressed.

## Scope and remaining gates

- This is one GPU family through two browser engines. A wider GPU/OS/driver matrix remains a release gate; no support is inferred from software-only results.
- Shared frontend/TypeScript/Cargo development load and root dependency updates occurred during measurement. The [paired performance archive](../../../perf/results/2026-09-08-gpu-development-load/README.md) preserves all samples and limitations.
- Priority scheduling, consumer cancellation, durable indexing completion and stale-result publication checks belong to plans 20–21. The GPU owner only reports readiness/failure and returns completed vectors.
- Tokenizer-only exact source offsets and an untruncated token stream remain separate chunker integration work.

Reproduce with the [hardware suite](../../gpu/README.md). [checksums.json](./checksums.json) records every raw JSON report hash; the deliberately failed report remains visibly failed.
