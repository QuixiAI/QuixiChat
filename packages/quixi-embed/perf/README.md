# CPU encoder measurements

This harness measures the production TypeScript API in Node or a dedicated browser
worker: UTF-8 input transfer, the C tokenizer and complete six-layer encoder, and
normalized FP32 output copies. It records first-instance load time separately from
asset retrieval, fixed WASM ownership, raw samples, median/p95, chunks/second and
tokens/second. It does not substitute isolated kernel timings for embedding calls.

Each shape receives five warmup calls **per route**, followed by thirty measured
calls per route. Scalar/SIMD order alternates for each pair. Vector comparisons
and memory checks happen outside the timing; neither production backend caches
results. Both model instances remain resident during the paired run. The batch
adapter serially processes documents in one reusable workspace; batch throughput
should not be interpreted as parallel or padded tensor batching.

After `python3 packages/quixi-embed/native/ci.py --simd --browsers`:

```sh
node --experimental-strip-types packages/quixi-embed/perf/run.mjs
node packages/quixi-embed/perf/browser.mjs chromium
node packages/quixi-embed/perf/browser.mjs all
```

The default matrix is batches 1/4/8/16/32 × lengths 32/128/512, using varied
single-token words. Every input is independently tokenized to verify its requested
shape. Runs can take over an hour per runtime. `--short` explicitly selects only
32-token shapes; it retains all batch sizes and the complete sampling protocol
but **does not satisfy the full performance matrix**. Node takes an optional output
filename before `--short`. Browser reports identify actual engine versions, disable
WebGPU inside the worker, and record asset hashes and host information.

```sh
python3 packages/quixi-embed/perf/summarize.py --require-full \
  packages/quixi-embed/build/simd-performance-chromium.json
```

Summary validation rejects unfinished runs, missing/repeated samples, numeric
failures, any measured median regression, or lack of a full matrix when requested.
Raw reports are written after each completed configuration; interrupted/failed runs
must not be used as passed evidence. This is a local paired comparison under the
recorded ambient conditions, not a controlled cross-device performance claim.

## Scalar profile and retained kernels

[scalar-profile.json](scalar-profile.json) records 5 warmups and 30 samples at
32/128/512 tokens in the original scalar WASM module. Its diagnostic-only monotonic
stage timer is compiled out of production. Reproduce the instrumentation with:

```sh
python3 packages/quixi-embed/native/build.py --target wasm --profile
node packages/quixi-embed/perf/profile.mjs
```

Dense Q/K/V, attention output, and FFN projections dominate short inputs. At 512
tokens, attention is also material. The SIMD implementation therefore uses explicit
four-lane dot accumulation for these fixed widths (32/384/1536) and four-lane
weighted-value accumulation for attention. The lanes preserve the scalar FP32
summation order, and floating-point contraction remains disabled. LayerNorm's
FP64 statistics, exact erf GELU, and scalar softmax were retained: their smaller
measured cost did not justify changing the frozen numerical operations. No
alternate packed weight layout or model-format revision was necessary.

The initial dot-only prototype was replaced by the combined dot/attention kernel
before end-to-end performance evaluation. It has no independent speedup claim.
No attempted numerical approximation or failed optimization was retained.

## Development-load evidence and controlled replay

The initial macOS M5 Max run took place alongside frontend/TypeScript builds,
browser tests, and Cargo compilation elsewhere in this shared workspace. Its
alternating pairs reduce ordering bias but cannot remove CPU, cache, memory or
thermal contention. Treat those measurements as directional development-load
evidence, **not quiescent or release-grade latency/throughput**. Numerical and
retrieval checks are independent of this performance limitation.

Preserve the raw development-load reports. After heavy jobs have finished, a
controlled replay should use a separate output directory and record the actual
power, thermal and background-process conditions:

```sh
node packages/quixi-embed/perf/browser.mjs all \
  --output-dir packages/quixi-embed/build/controlled-replay
```

A successful numeric/performance report means its stated sample protocol and
comparison passed under the recorded conditions; it does not certify quiet-host
conditions. Later release validation must make that distinction explicitly.

## Recorded results and memory ownership

The [preserved development-load results](results/2026-09-08-development-load/README.md)
include the full 15-shape Chromium matrix and five 32-token batch comparisons in
each of Firefox and WebKit. Median speedups were 1.87–2.04×, 2.08–2.11× and
2.02–2.04× respectively; every timed result matched scalar exactly. The archive
contains unchanged raw reports, checksums and explicit runtime/load conditions.

The [allocator observation](../tests/reports/simd-allocator-report.json) uses the
same production C sources with one additional `mallinfo` export. It measures a
182,016,928-byte peak during model validation/copy and 100,149,952 live bytes after
workspace and binding scratch allocation. Twenty forwards leave that allocation
unchanged; disposal returns live C allocations to zero. WASM retains its
183,107,584-byte reservation until the instance is collected or its worker ends.
This is allocator evidence, separate from throughput instrumentation and OS RSS.

The [production ownership run](../tests/reports/simd-memory-report.json) completes
2,000 actual API jobs after 100 warmups, with fixed WASM memory and retained JS
heap inside a 2 MiB bound after test-only forced garbage collection. Caller-retained
output arrays are outside the runtime's ownership. Reproduce both observations:

```sh
python3 packages/quixi-embed/native/check_memory.py
node --expose-gc --experimental-strip-types packages/quixi-embed/tests/cpu-memory.mjs
```

Both checks are included in `native/ci.py --simd`. CPU batches execute serially;
the scheduler should yield between individual documents to admit priority queries.
A 32-document synchronous call blocks its worker for the complete batch.
