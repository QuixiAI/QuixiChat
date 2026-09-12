# Reproduce the Arctic XS reference

These are **offline engineering tools**. They are never imported by the public
TypeScript runtime or bundled into the application. Commands below run from the
repository root. Downloaded weights and the Python environment remain under
ignored `packages/quixi-embed/build/`.

## Set up and verify sources

Use Python 3.11.15 and the checked-in package/hash lock. The original measured platform is
macOS arm64, and `requirements.lock` is specific to that environment. Linux
x86_64 uses the separate `requirements-linux-cpu.lock`, which pins the official
PyTorch CPU wheel and resolves Linux dependencies without CUDA packages.
Numerical tolerances, rather than byte-identical float output across hardware,
are the reproducibility criterion. `uv` is only an environment installer.

```sh
uv venv --python 3.11.15 packages/quixi-embed/build/reference-env
uv pip sync --python packages/quixi-embed/build/reference-env/bin/python \
  --require-hashes packages/quixi-embed/reference/requirements.lock
python3 packages/quixi-embed/reference/fetch.py
```

`fetch.py` streams and verifies all eleven revision-pinned model files before
renaming downloads into place. The reference loader rechecks every file's size
and SHA-256 before loading. Once fetched, inference sets both Hugging Face offline
flags and `local_files_only=True`; generation requires no network connection.
The model card is the source of the Apache-2.0 declaration; its hash is locked.
The standard Apache license is included as `LICENSE-Arctic.txt` because upstream
did not provide a standalone license file in this snapshot.

`requirements.txt` captures the original version pins; `requirements.lock`
freezes the complete resolved install, including dependency extras, and adds
distribution hashes. `runtime-source-lock.json` identifies the inspected
upstream BERT and tokenizer source implementations, in addition to the installed
package lock. Goldens carry the source identity and measured environment.

## Generate and validate

```sh
packages/quixi-embed/build/reference-env/bin/python \
  packages/quixi-embed/reference/generate.py \
  --output packages/quixi-embed/build/reproduced-goldens
packages/quixi-embed/build/reference-env/bin/python \
  packages/quixi-embed/reference/compare.py \
  packages/quixi-embed/build/reproduced-goldens --route scalar-fp32 \
  --report packages/quixi-embed/build/reproduction-report.json
packages/quixi-embed/build/reference-env/bin/python -m unittest discover \
  -s packages/quixi-embed/reference -p 'test_*.py'
python3 -m unittest discover -s perf/retrieval -p 'test_*.py'
```

The default generator output is `tests/goldens`; do not regenerate that baseline
to hide a candidate failure. Use a separate output directory as above. NPZ files
contain typed NumPy arrays and can be decoded offline with `allow_pickle=False`.
The manifest records the exact input, role, array names/shapes, and artifact hash.
Hidden stages are full `[batch,tokens,384]` arrays for the three diagnostic cases;
all remaining cases retain token arrays, CLS pooling, and final vectors. The
inventory records all 101 source tensors and their raw FP32 content hashes.

A future backend exports the same candidate NPZ/manifest format and runs
`compare.py --route wasm-simd-fp32`, `webgpu-fp32`, or `webgpu-fp16`. Force the
requested backend; a fallback must not masquerade as a passing optimized route.
Every route must export all cases. Stage snapshots may come from a diagnostic
build of the same graph. Add fixtures around new dispatch boundaries before
shipping them. The checked-in `reproduction-report.json` concerns the offline
reference only; it does not validate any unimplemented production backend.

## C/WASM feasibility

With Docker, clang, and Node available:

```sh
python3 packages/quixi-embed/reference/check_toolchain.py
```

This builds a scalar native dot-product probe and the same source as WASM SIMD
using the content-addressed Emscripten 4.0.10 image already used for SQLite builds.
It executes the native program and the WASM module through the Node C ABI. The
checked-in evidence reports the commands' identities and result. Build evidence
is deliberately separate from the later inference speed measurements.

## Retrieval

See [the corpus, metrics, and benchmark procedure](../../../perf/retrieval/README.md).
Current measurements are an offline CPU baseline. The large-archive, compressed
index, WASM, WebGPU, scheduler, and application integration gates remain in
subsequent numbered plans.
