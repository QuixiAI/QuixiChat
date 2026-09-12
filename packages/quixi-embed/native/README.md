# C scalar/SIMD encoder and WASM runtime

This is the owned Arctic XS tokenizer, fixed six-layer BERT encoder, model loader,
and reusable CPU workspace. The [port contract](../PORT_SPEC.md) fixes numerical
semantics. No BLAS, ONNX, PyTorch, generic graph interpreter, UI, database, or
native server is required by the runtime.

## Build and provision

The supported CI entry is Linux x86_64 with **uv, Python 3.11.15 provisioning,
clang, Docker, Node 22.23.1 or newer, and root `npm ci`** available:

```sh
python3 packages/quixi-embed/native/ci.py
```

This creates/synchronizes the isolated Python environment, uses the Linux
CPU-only dependency/hash lock, downloads and verifies all frozen public model
inputs, compiles model and tokenizer assets, builds native and scalar WASM
production libraries, and runs reference, loader, Unicode, metric, and Node WASM
API checks. It does not assume ignored build artifacts already exist. On macOS
arm64 the same command uses the macOS reference lock, but Docker must be installed;
hosted macOS CI without Docker should consume artifacts built by the Linux job.

Add `--full` for all 159 native and scalar-WASM numerical cases plus native
retrieval, which can take tens of minutes on a development machine. Add
`--browsers` for Chromium, Firefox, and WebKit worker checks. Browser binaries are
provisioned by that flag; Linux system libraries must be installed by the CI job
(e.g. Playwright's system-dependency setup) before browser execution.

For plan 18's independent SIMD verification, the following provisions both WASM
routes without requiring a desktop native compiler or native library:

```sh
python3 packages/quixi-embed/native/ci.py --simd --browsers
```

This uses the same pinned Python/Docker/Node prerequisites, builds both production
WASM routes, verifies the versioned distribution, runs 2,400 forced scalar/SIMD
kernel comparisons, allocator peak/disposal and 2,000-job retained-memory checks,
and checks ownership/role/bounds and actual browser workers.
Add `--full` for all 159 SIMD golden cases and the 659-chunk retrieval gate. The
existing command without `--simd` continues to verify the native/scalar foundation.

The native production build also produces a standalone C executable:

```sh
packages/quixi-embed/build/qx-embed packages/quixi-embed/build/arctic-xs.qxmodel query "Where did we decide to use OPFS?"
```

It prints one normalized 384-value JSON array without Python, a UI, or a server.
Individual build commands, from the repository root:

```sh
python3 packages/quixi-embed/native/build.py --target native
python3 packages/quixi-embed/native/build.py --target native --diagnostic
python3 packages/quixi-embed/native/build.py --target wasm
python3 packages/quixi-embed/native/build.py --target wasm --diagnostic
python3 packages/quixi-embed/native/build.py --target wasm --simd
python3 packages/quixi-embed/native/build.py --target wasm --simd --diagnostic
```

WASM compilation uses the digest-pinned Emscripten 4.0.10 Docker image shared with
SQLite. All scalar builds disable SIMD, auto-vectorization, SLP vectorization,
and floating-point contraction. `--simd` adds explicit `wasm_simd128.h` kernels while keeping automatic
vectorization and contraction disabled; it does not change the frozen model format.
`toolchain_probe.c` is a separate four-element
SIMD feasibility probe and is not part of the scalar runtime. Native libraries
are `.dylib` on macOS and `.so` on Linux. `.wasm` and model outputs stay in ignored
`build/`; build manifests record source/artifact hashes and actual commands.

## API and memory

[quixi_embed.h](quixi_embed.h) declares model/tokenizer loaders, tokenization,
workspace reservation/free, token/mask inference, and query/document convenience
calls. [The TypeScript facade](../src/scalar.ts) wraps the production C WASM ABI;
[the standalone tokenizer facade](../src/tokenizer.ts) loads vocabulary/Unicode
rules without model weights. Use CPU inference in a dedicated worker because
its execution is synchronous. The [scheduler](../src/scheduler/README.md) adds
priority, cancellation and a task yield after each complete CPU dispatch. `createScalarEncoder` and `createSimdEncoder` force the selected route
and verify its C backend identity; `supportsWasmSimd` enables capability selection
before loading an artifact. Constructors never silently substitute another backend.

A model owns its copied verified package and lookup table. One serial inference
owner uses one workspace; callers may share immutable weights across distinct
workspaces. Production WASM reserves **7,866,420 bytes** per 512-token workspace,
independent of batch size. Both CPU batch adapters process up to 32 items in
order using that workspace. A model owns **91,231,307 bytes** and a tokenizer-only
handle **959,947 bytes** in the measured WASM build. Public API scratch buffers
and the WASM allocator account for additional memory; the measured linear-memory
reservation is 183,107,584 bytes after model loading. The [allocator observation](../tests/reports/simd-allocator-report.json) measures
182,016,928 peak live bytes during model loading and 100,149,952 steady live bytes,
returning to zero after disposal. No heap allocation occurs inside the C forward
pass or streaming tokenizer. A separate 2,000-job production API check verifies
fixed WASM memory and bounded retained JS heap.

The 1 MiB UTF-8 input bound is separate from the 512-token input limit. C rejects
malformed UTF-8; JavaScript TextEncoder uses replacement characters for isolated
surrogates before C normalization. Model packages are capped at 128 MiB,
tokenizer packages at 2 MiB, and WASM memory at 512 MiB. The allocator can retain
freed pages; dispose frees C allocations and drops instance references, while
terminating the worker provides a clear resource lifetime boundary.

Diagnostic builds add seven fixed stage buffers and the stage/pooled accessors.
Those exports and buffers are absent from production. Fixtures test padding even
though the scalar public batch adapter may execute unpadded items separately.

## Validation commands

After provisioning:

```sh
packages/quixi-embed/build/reference-env/bin/python -m unittest discover -s packages/quixi-embed/tests -p 'test_native.py'
packages/quixi-embed/build/reference-env/bin/python packages/quixi-embed/reference/check_unicode.py
node --experimental-strip-types packages/quixi-embed/tests/scalar-api.mjs
node packages/quixi-embed/tests/browser-check.mjs
```

The native safety executable can be built with address and undefined-behavior
sanitizers from `model.c`, `tokenizer.c`, `encoder.c`, `sha256.c`, and
`tests/native-safety.c`; pass the compiled `.qxmodel` path as its sole argument.
[The evidence index](../tests/reports/README.md) records measured results and
separates native, Node WASM, browser-worker, and untested host/platform claims.

## Versioned distribution

The repository publishes the small production modules in
[`artifacts/1.0.2`](../artifacts/1.0.2/manifest.json). Model format remains v1; model
weights are provisioned separately and verified by the C loader. Version 1.0.1
adds strict token overflow inspection and the owned SHA-256 export; numerical
semantics are unchanged. The 1.0.0 distribution and its historical measurements
remain preserved. Version 1.0.2 adds the bounded [original-source offset ABI](../src/TOKEN_OFFSETS.md),
with unchanged token IDs and model arithmetic; 1.0.1 also remains preserved.
The public facade now allocates an additional 32-byte digest
buffer; the allocator numbers above describe the archived 1.0.0 observation.
Rebuilding with
the pinned Docker image must reproduce both module checksums:

```sh
python3 packages/quixi-embed/native/release.py
```

An explicit `--write` updates this local distribution during a versioned release.
There is no external registry/CDN upload in this task. Production modules omit
profiling timers and diagnostic stage exports. Their exported C backend identity
is 0 for scalar and 1 for SIMD. The SIMD module requires standard WASM SIMD128;
there is no relaxed-SIMD, threads, SharedArrayBuffer, or WebGPU requirement.

See the [paired benchmark instructions](../perf/README.md) for runtime-specific
latency/throughput evidence and the distinction between full and short matrices.
