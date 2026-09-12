# Owned WebGPU encoder

The fixed Arctic XS graph runs entirely in versioned WGSL. JavaScript verifies
artifact identities, transfers inputs, records commands and copies final vectors.
The C tokenizer loads its independent `.qxtokenizer` asset; GPU initialization
does not allocate a CPU model/encoder. No inference framework is shipped.

```ts
const encoder = await createWebGpuEncoder({
  model, tokenizer, wasm: scalarWasm,
  shader: baselineWgsl, tiledShader: tiledWgsl, attentionShader: attentionWgsl,
  projection: 'auto', attention: 'fused', maxBatch: 4,
  tuningCache, // Optional adapter supplied by the product's storage owner.
});
const vector = await encoder.embedQuery('Where was this decision recorded?');
encoder.dispose();
```

All assets are caller-provided. The factory performs no model download and
requires the frozen model and exact checksummed shader sources. `baseline`,
`tiled`, and `half` force projection implementations. `half` additionally requires
the bundled half shader and `shader-f16`; it uses FP16 projection weights, input
tiles and products with FP32 accumulation. Other graph operations and returned
vectors remain FP32. The full FP32 weight copy remains resident for those
operations, so this route adds a persistent half-weight copy. `auto` selects only
between FP32 projection variants. Missing optional features never disable the
independent WASM SIMD API.

Subgroup normalization is an explicit experiment. Its measured regressions keep
it outside the public production factory. The independent baseline remains
available for diagnosis and small-input performance.

## Resource and scheduler contract

- One instance owns one device/queue, immutable weights, a tokenizer and fixed
  GPU scratch/readback buffers. Capacity is chosen at initialization: batch 1–32,
  tokens 2–512, default batch 1/tokens 512. The default owned-buffer budget is
  512 MiB. Admission checks both aggregate bytes and device binding/buffer limits.
- An instance accepts one active asynchronous batch. Concurrent embedding calls
  reject with `busy`; there is no internal request queue or singleflight cache.
  Public document batches are padded and execute together in original order.
- Token IDs and masks upload before the complete six-layer graph. Intermediate
  activations remain GPU-resident. Production execution uses one final vector
  readback and allocates no new GPU buffers. Diagnostic stage capture and
  timestamp profiling are separate observation modes.
- The scheduler owns priorities, admission, cancellation and retries. A submitted
  command buffer cannot be selectively cancelled. Priority changes take effect
  between bounded graph/batch executions; cancelling a job suppresses publication
  of its result. Choose background batch size from measured completion time.
- Device loss or execution failure invalidates pending work, destroys owned
  resources and rejects incomplete results. `dispose()` is idempotent and also
  rejects pending execution. The callback is a status notification; throwing
  from it cannot restore the failed backend or publish a partial vector.
- Catch `GpuBackendError` and explicitly initialize/requeue on WASM SIMD when
  appropriate. Its `code`, `message` and `fallback` fields must be serialized
  explicitly across worker RPC; do not rely on custom Error fields surviving
  structured cloning. Initialization rejection is reported by the factory promise.

The GPU runtime never writes canonical history, vectors or job status to storage.
The plan 20 scheduler must reject cancelled/stale-version results before a storage
write. Loss of GPU availability leaves history and lexical search usable.

## Tuning and identity

Auto mode measures three size buckets using at most 24 actual graph executions,
with one warmup and three alternating sample pairs per bucket. It stops admitting
probes after 750 ms; an already submitted graph must finish. A variant needs a
10% timing margin before replacing the baseline. An exhausted tuning budget
leaves remaining buckets on the baseline.

An optional `TuningCache` provides asynchronous `get`/`set` to the product storage
owner. The runtime opens no database. Cache calls have a 50 ms observation bound;
missing, corrupt, failed or timed-out storage does not disable inference. Records
are copied and validated. Keys include model identity, the runtime source hash,
shader contents, adapter information, enabled features/limits, browser user agent
and workspace capacity. Changes invalidate earlier selections. Startup samples
guide selection; they do not replace full paired performance measurements.

## Measurement limits

`diagnostics().memory` reports the static reserved buffer sizes and the current
owned buffer count. Reserved byte fields remain the capacity plan after disposal;
lifecycle tests separately observe every real allocation/destruction and the peak. It cannot report driver-private allocations, process RSS or
physical device heap usage: WebGPU exposes no such accounting API. Budget caller
asset buffers, the temporary verified model copy, tokenizer WASM memory and driver
overhead separately. The verified model copy is released after upload completion;
destroyed GPU buffers may be physically reclaimed asynchronously.

`lastTimings()` separates tokenization, host input writes, command encoding/submit,
and completion/readback wall time. The last interval includes outstanding GPU
execution; it is not a pure copy measurement. Optional timestamp profiling
requests `timestamp-query` and uses separate instrumented passes. Those timings
can be quantized (65,536 ns steps were observed on this host), and the extra pass
boundaries make them unsuitable for production end-to-end latency claims.

Actual hardware evidence is recorded per browser/adapter. Default headless
Chromium on this host exposes no adapter; the harness explicitly enables GPU and
Metal on macOS. Headed Chromium and WebKit also expose a nonfallback Apple adapter.
Software-only execution is never counted as hardware support.

The existing tokenizer-only API returns bounded IDs without exact source offsets
or an untruncated stream. Model-aware shared chunking still needs that separate C
offset-emission interface; reconstructing offsets from normalized IDs is invalid.

Reproduce hardware checks with the [hardware suite](../../tests/gpu/README.md).
The [source manifest](../../kernels/webgpu/1.0.0/manifest.json) is verified by
`python3 native/gpu_release.py`; `--write` is an explicit local version freeze,
not a deployment or external publication. Kernel sources are exported through
`@quixi/quixi-embed/kernels/*` for caller-controlled bundling.
