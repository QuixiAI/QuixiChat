# QuixiChat

QuixiChat is a minimal native macOS chat client for fast, fully local Gemma 4 E2B inference. It owns the complete inference path: GGUF loading, the checkpoint's Jinja chat template, tokenization, KV caching, quantized Metal kernels, streaming, context management, and the desktop UI.

The fixed model is downloaded directly from its publisher on first launch and verified against a pinned SHA-256 digest. Prompts and responses remain on the machine.

## Product limits

- 128K-token context window
- Up to 32K newly generated tokens per response
- Automatic conversation compaction at 90K history tokens
- Separate streamed thinking and answer channels
- Thinking is collapsed by default and excluded from subsequent model history

## Development

Requirements: macOS on Apple silicon, Rust 1.92+, and Xcode with the Metal toolchain.

```sh
cargo test --workspace
cargo run
cargo run -- bench
```

Build both distributable macOS artifacts with:

```sh
./scripts/build-macos.sh
```

The script preserves `QuixiChat.app` alongside the generated DMG.
