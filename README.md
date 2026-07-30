# QuixiChat

<img width="960" height="640" alt="image" src="https://github.com/user-attachments/assets/3bc39718-094a-4f4c-924a-c56ae9a77f50" />


QuixiChat is a small, complete native chat app for running Gemma 4 E2B locally on Apple silicon. It implements the entire path from a pinned GGUF file to streamed text: model loading, tokenization, the checkpoint's chat template, KV caching, Metal inference, thinking, conversation compaction, authenticated loopback HTTP, and the desktop UI.

This is an opinionated teaching implementation, not a framework. There is one model, one Metal backend, greedy decoding, no runtime settings, and no JavaScript toolchain. The binary opens the app when run without arguments; `bench` is its only subcommand.

## What it demonstrates

- Direct GGUF parsing and validation against an exact tensor contract
- A byte-fallback BPE tokenizer reconstructed from GGUF metadata
- The checkpoint's own Jinja chat template instead of a handwritten approximation
- Q4_0 and Q6_K Metal kernels dispatched on Burn's CubeCL/wgpu stream
- Local and global KV caches reused across conversation turns
- Separate streamed thinking and answer channels
- Automatic model-driven compaction at 90K tokens within a 128K context
- A dependency-free HTML/CSS/JavaScript interface embedded in the Rust binary

## Structure

| Path | Responsibility |
|---|---|
| `crates/quixi-chat` | Model installation, Tauri lifecycle, and the benchmark command |
| `crates/quixi-chat-server` | Embedded UI, authenticated loopback API, and the inference worker |
| `crates/quixi-chat-engine` | GGUF, tokenizer, template, KV cache, compaction, and model execution |
| `crates/quixi-chat-kernels` | Burn/CubeCL integration for the custom Metal kernels |
| `kernels/metal` | Focused Metal Shading Language sources |

Read the crates in that order for the application flow, then use [docs/model.md](docs/model.md) for the pinned architecture contract. [docs/performance.md](docs/performance.md) records the measured path from roughly 60 toward 200 decode tokens per second. The only vendored dependency is a documented ownership fix in [vendor/cubecl-runtime/QUIXI_CHAT_PATCH.md](vendor/cubecl-runtime/QUIXI_CHAT_PATCH.md).

## Run

Requirements: macOS on Apple silicon, Rust 1.92+, and Xcode with the Metal toolchain.

```sh
cargo test --workspace
cargo run
cargo run -- bench
```

The first launch downloads the 3.35 GB pinned checkpoint and verifies its size and SHA-256 digest. Later launches use the local copy. Prompts and responses never leave the machine.

Build the unsigned standalone app and DMG with:

```sh
./scripts/build-macos.sh
```

## Model and license

The weights are not included in this repository. QuixiChat downloads Google's [Gemma 4 E2B Q4_0 GGUF](https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf) at the immutable revision and digest declared in `crates/quixi-chat/src/models.rs`. The checkpoint is Apache-2.0; QuixiChat's source is MIT-licensed.
