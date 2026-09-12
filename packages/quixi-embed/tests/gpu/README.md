# Real hardware WebGPU checks

The independent kernel oracle is generated with pinned offline Python/NumPy FP64
math. Full graph checks use the original 159 pinned PyTorch cases plus 30
supplemental query/document cases at tile boundaries 15, 16 and 17, batches
1/4/8/16/32. The supplemental NPZ files retain all seven normalized hidden stages,
pooled values, final vectors, IDs and masks; their manifest pins hashes and source
identity. They do not replace or alter the original goldens. Model-derived fixture
provenance remains the Apache-2.0 Arctic XS source in the manifest.

`generate_gpu_boundaries.py` reproduces the supplemental oracle with the frozen
reference environment; `generate_gpu_kernel_fixtures.py` provisions ignored raw
kernel arrays. JavaScript in these tests transfers fixtures, drives execution and
compares outputs. Production numerical kernels remain C/WGSL.

From the repository root, after installing the root's locked JavaScript packages:

```sh
python3 packages/quixi-embed/native/gpu_ci.py --full --engines chromium webkit
```

The supported provisioning hosts are Linux x86_64 (the explicit CPU-only Torch
lock) and macOS arm64 (its separate lock). Provisioning requires `uv`, Node,
Docker, public artifact downloads and the pinned Emscripten image. Browser binaries
are installed explicitly before the hardware probe. This entry reuses the verified
SIMD provisioner; it does not assume ignored model/WASM files already exist.
Hosted macOS without Docker must use provisioned artifacts or a suitable runner.
On a verified local build, `--skip-provision` preserves the existing reference
environment and requires the model/tokenizer/scalar/SIMD assets to exist.

The full suite forces all seven retained projection/attention combinations in
both original and supplemental graph fixtures and in the 659-chunk/18-query
retrieval corpus. Smoke mode runs independent kernels and the 500-job lifecycle
checks. FP16 hardware tests require `shader-f16`; this does not make FP16 a
requirement for the production FP32 or SIMD APIs. A missing or software adapter
returns nonzero and records unavailable hardware. It is never converted to a
passing GPU result. The report is invalidated before preflight and records each
failed command/exit status, including process-launch failures.

Chromium on the measured macOS host requires `--enable-gpu --use-angle=metal`
in headless mode. The harness records these explicit hardware-enabling flags;
Linux uses `--enable-gpu` without forcing a software adapter. WebKit's default
headless configuration exposed a real Apple adapter. Firefox's tested default
configuration did not expose an adapter. These findings apply to the recorded
browser builds and host, not to every installation of those browsers.

The public factory rejects subgroup normalization; `--subgroups` is an internal
experiment only. Full-graph stage capture and timestamp profiling are separate
observation paths. Lifecycle and retrieval checks call the public production
factory, with no stage capture or intermediate readback.

[Archived hardware evidence](../reports/gpu-2026-09-08/README.md) and
[raw paired performance](../../perf/results/2026-09-08-gpu-development-load/README.md)
record the scope and remaining hardware coverage.
