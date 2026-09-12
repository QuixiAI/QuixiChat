# WebGPU measurements — shared development host

All paired runs use five warmups and 30 alternating samples per route. Every output is compared outside the timed interval. The complete GPU matrices cover batches 1/4/8/16/32 and token lengths 32/128/512. Six final runs cover both actual Chromium/Metal and WebKit Apple adapters; the two CPU/GPU comparisons use batch-one anchors. This is one M5 Max hardware family, with the limitations in [conditions.json](./conditions.json).

## Retained choices

- Tiled FP32 improves medium/large work but regresses B1/T32 in the original isolated comparison (0.545×). Auto keeps a measured baseline option for small inputs.
- Fused FP32 attention improved or tied the original 15-shape comparison (1.000–1.121×) and removes the 402,653,184-byte scores buffer at B32/T512.
- Final auto/fused improves or ties the baseline across all 15 shapes: 1.037–3.788× in Chromium and 1.000–2.271× in WebKit.
- Optional half/fused is not the default. Relative to auto/fused it regresses B1/T32 (0.722× Chromium; 0.500× WebKit). Other measured shapes improve or tie, up to 1.214× and 1.800× respectively. It adds 45,130,752 bytes of persistent half weights; FP32 weights remain resident.
- Subgroup normalization is rejected for production: its valid 15-shape experiment included regressions to 0.935×. The public API rejects this route.

## Paired SIMD anchors

These use the same worker, public model/tokenizer APIs, input and alternating order. GPU timing includes input preparation/transfer, the full graph and final readback. SIMD runs actual C/WASM, without JavaScript numerical kernels.

| Engine | Tokens | SIMD median ms | GPU median ms | Speedup |
|---|---:|---:|---:|---:|
| chromium | 32 | 36.10 | 3.90 | 9.26× |
| chromium | 128 | 145.05 | 6.60 | 21.98× |
| chromium | 512 | 673.45 | 13.70 | 49.16× |
| webkit | 32 | 38.00 | 4.00 | 9.50× |
| webkit | 128 | 152.00 | 10.50 | 14.48× |
| webkit | 512 | 650.00 | 17.00 | 38.24× |

## Full matrices and observation costs

| Engine | Batch | Tokens | Baseline ms | Auto/fused ms | Speedup |
|---|---:|---:|---:|---:|---:|
| chromium | 1 | 32 | 2.80 | 2.70 | 1.04× |
| chromium | 4 | 32 | 6.50 | 4.90 | 1.33× |
| chromium | 8 | 32 | 10.50 | 5.55 | 1.89× |
| chromium | 16 | 32 | 19.35 | 7.40 | 2.61× |
| chromium | 32 | 32 | 36.50 | 11.70 | 3.12× |
| chromium | 1 | 128 | 6.25 | 4.95 | 1.26× |
| chromium | 4 | 128 | 19.90 | 8.10 | 2.46× |
| chromium | 8 | 128 | 37.80 | 12.95 | 2.92× |
| chromium | 16 | 128 | 75.40 | 23.95 | 3.15× |
| chromium | 32 | 128 | 126.90 | 33.50 | 3.79× |
| chromium | 1 | 512 | 19.10 | 7.30 | 2.62× |
| chromium | 4 | 512 | 73.30 | 24.90 | 2.94× |
| chromium | 8 | 512 | 148.75 | 52.60 | 2.83× |
| chromium | 16 | 512 | 301.30 | 107.05 | 2.81× |
| chromium | 32 | 512 | 596.40 | 224.70 | 2.65× |
| webkit | 1 | 32 | 2.00 | 2.00 | 1.00× |
| webkit | 4 | 32 | 5.00 | 5.00 | 1.00× |
| webkit | 8 | 32 | 9.00 | 9.00 | 1.00× |
| webkit | 16 | 32 | 17.00 | 9.00 | 1.89× |
| webkit | 32 | 32 | 33.00 | 15.00 | 2.20× |
| webkit | 1 | 128 | 5.00 | 5.00 | 1.00× |
| webkit | 4 | 128 | 17.50 | 9.00 | 1.94× |
| webkit | 8 | 128 | 34.00 | 16.00 | 2.12× |
| webkit | 16 | 128 | 78.50 | 36.00 | 2.18× |
| webkit | 32 | 128 | 134.00 | 59.00 | 2.27× |
| webkit | 1 | 512 | 20.00 | 11.00 | 1.82× |
| webkit | 4 | 512 | 78.00 | 39.00 | 2.00× |
| webkit | 8 | 512 | 154.00 | 78.50 | 1.96× |
| webkit | 16 | 512 | 308.00 | 161.50 | 1.91× |
| webkit | 32 | 512 | 621.50 | 337.00 | 1.84× |

Raw JSON includes all samples, p95, chunks/second, tokens/second, fresh-instance initialization time, adapter features/limits, tuning decisions, allocation plans and tokenization/input-write/dispatch/completion intervals. The ordinary completion/readback interval includes GPU execution; it is not a pure copy measurement.

`baseline-profile-chromium.json` records separate timestamp-query passes. Linear projections dominate these GPU measurements; attention costs grow at longer lengths. The instrumented path has extra pass boundaries and quantized timestamps, so its durations do not replace production latency. `baseline-transfer-profile-chromium.json` additionally observes queue completion before mapping, then times mapping/copy/unmap independently: mean final vector readback was 0.070/0.087/0.097 ms at 32/128/512 tokens. Timestamp readback is recorded separately. This test-only synchronization is absent from the production runtime. Host input-write time is reported separately; it is not a physical DMA counter.

Full query/backfill observations use the public production API over 659 actual chunks and 18 queries; raw per-batch/query measurements and fresh-instance initialization are in the [retrieval evidence](../../../tests/reports/gpu-2026-09-08/README.md). Those single corpus passes are not 30-sample throughput experiments. Scheduler priority/cancellation and large-index workloads belong to plans 20 and22–23.

## Reproduction

Provision using the [hardware suite](../../../tests/gpu/README.md), then run from the repository root:

```sh
node packages/quixi-embed/perf/gpu-browser.mjs chromium packages/quixi-embed/build/gpu-auto.json --auto
node packages/quixi-embed/perf/gpu-browser.mjs webkit packages/quixi-embed/build/gpu-half.json --finalhalf
node packages/quixi-embed/perf/gpu-browser.mjs chromium packages/quixi-embed/build/gpu-anchors.json --anchors
node packages/quixi-embed/perf/gpu-profile.mjs --transfers
python3 packages/quixi-embed/perf/check_gpu.py packages/quixi-embed/build/gpu-auto.json packages/quixi-embed/build/gpu-half.json packages/quixi-embed/build/gpu-anchors.json
```

The paired checker validates completion, the complete shape matrix, finite 30-sample sets, recomputed statistics and numerical gates. The [validation report](./validation.json) passes all ten paired files. The two profile files use a separate timestamp/transfer observation schema. [checksums.json](./checksums.json) seals every raw JSON artifact in this directory.
