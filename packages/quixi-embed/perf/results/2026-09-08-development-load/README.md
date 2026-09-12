# Development-load CPU results — 2026-09-08

These raw reports were preserved without changing their measured samples. The
[conditions](conditions.json) identify known concurrent development work. These
results show directional performance under that load; they are not quiescent or
release-grade latency claims. A controlled replay must use separate output files.

| Engine | Measured shapes | Median speedup range |
| --- | --- | --- |
| chromium 153.0.8010.12 | 15 (full matrix) | 1.87–2.04× |
| firefox 155.0 | 5 (32-token comparison) | 2.08–2.11× |
| webkit 26.6 | 5 (32-token comparison) | 2.02–2.04× |

All shapes use five warmups and thirty alternating samples per route. Every
measured output exactly matched scalar; WASM memory remained fixed. All runs use
the same v1 model and version 1.0.0 production modules.

## Chromium full matrix

| Batch | Tokens | Scalar median / p95 ms | SIMD median / p95 ms | Speedup | SIMD chunks/s | SIMD tokens/s |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 32 | 66.7 / 68.7 | 35.7 / 36.4 | 1.87× | 28.05 | 897.6 |
| 4 | 32 | 267.4 / 270.9 | 143.3 / 144.3 | 1.87× | 27.91 | 893.2 |
| 8 | 32 | 545.6 / 562.3 | 286.8 / 290.4 | 1.90× | 27.89 | 892.5 |
| 16 | 32 | 1101.8 / 1118.2 | 571.3 / 581.4 | 1.93× | 28.01 | 896.2 |
| 32 | 32 | 2229.2 / 2279.7 | 1144.5 / 1177.5 | 1.95× | 27.96 | 894.7 |
| 1 | 128 | 294.5 / 326.1 | 149.2 / 167.0 | 1.97× | 6.70 | 857.6 |
| 4 | 128 | 1205.5 / 1557.8 | 639.2 / 777.5 | 1.89× | 6.26 | 801.0 |
| 8 | 128 | 2284.0 / 2937.0 | 1181.3 / 1458.0 | 1.93× | 6.77 | 866.8 |
| 16 | 128 | 4662.0 / 4762.5 | 2363.6 / 2398.6 | 1.97× | 6.77 | 866.5 |
| 32 | 128 | 9182.2 / 11595.3 | 4718.2 / 5934.6 | 1.95× | 6.78 | 868.1 |
| 1 | 512 | 1365.8 / 1417.7 | 678.3 / 688.2 | 2.01× | 1.47 | 754.8 |
| 4 | 512 | 5639.2 / 7450.3 | 2789.2 / 3540.5 | 2.02× | 1.43 | 734.3 |
| 8 | 512 | 11357.6 / 13191.1 | 5564.5 / 6609.2 | 2.04× | 1.44 | 736.1 |
| 16 | 512 | 22223.1 / 26010.0 | 11042.3 / 12431.5 | 2.01× | 1.45 | 741.9 |
| 32 | 512 | 43091.2 / 43522.2 | 21140.4 / 21459.6 | 2.04× | 1.51 | 775.0 |

The first-instance load measured 516.6 ms for scalar and 515.5 ms for SIMD, excluding
asset retrieval. This includes module compilation/instantiation, frozen model
validation/copy and workspace allocation. Both instances remain resident during
the paired run. Per-instance WASM reservation is 183,107,584 bytes, with a
7,866,420-byte workspace; callers must also budget their model asset buffers.

Batching here is serial, so larger batches do not provide parallel throughput.
For CPU query priority, schedule individual documents and yield between them; a
single 32-document call blocks its worker until that entire serial batch completes.
