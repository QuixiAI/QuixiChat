# QuixiChat performance ideas

## Goal

Reach at least **200 raw decode tokens per second** for Gemma 4 E2B on the 40-core Apple M5 Max, initially at a 256-token prompt context.

This is a 5 ms/token target. Longer-context results must be reported separately because attention cost rises with context length.

## Measured baseline

Measurements were taken from the release binary on July 27, 2026:

| Prompt context | Decode throughput | Decode latency |
|---:|---:|---:|
| ~3 tokens | 68.2 tok/s | 14.66 ms/token |
| 258 tokens | 59.8 tok/s | 16.71 ms/token |
| 1,026 tokens | 55.3 tok/s | 18.09 ms/token |

At a 258-token prompt, prefill measured 81.7 tok/s. Prefill currently feeds the model one token at a time, so it is not a true batched-prefill measurement.

The current GGUF touches approximately 1.407 GB of weights during each decode token:

| Component | Bytes/token | Share |
|---|---:|---:|
| FFNs | 876 MB | 62.3% |
| Q6_K vocabulary head | 330 MB | 23.5% |
| Attention projections | 157 MB | 11.1% |
| PLE context projection | 28 MB | 2.0% |
| Other | 16 MB | 1.1% |

At 59.8 tok/s, the full decode loop realizes roughly 84 GB/s of effective weight throughput. Reaching 200 tok/s requires approximately 281 GB/s. The 40-core M5 Max has 614 GB/s of theoretical memory bandwidth, so the target is physically plausible at short context, but only if the complete decode path approaches the throughput of its best kernels.

Current kernel probes:

- Cold Q4_0 GEMV: approximately 188–299 GB/s, depending on shape.
- Wide FFN-down GEMV: approximately 156 GB/s.
- Fused Q6_K vocabulary argmax: 174.5 GB/s, or about 1.89 ms per call.

## Benchmark protocol

Use a stable primary benchmark:

```sh
target/release/quixi-chat bench \
  --prompt-tokens 256 \
  --decode-tokens 256 \
  --repeat 7
```

Extend the harness to report warmup, best, median, and context length. Keep secondary gates at 1K and 8K context so short-context improvements cannot conceal attention regressions.

For each experiment:

1. Record wall-clock decode tok/s and ms/token.
2. Record GPU kernel time, bandwidth, occupancy, and limiter counters.
3. Verify identical greedy token IDs on frozen prompts.
4. Check for NaNs and compare rewritten kernel outputs against reference tensors.
5. Retain an optimization only when the median improvement is at least 3% without a correctness regression.

For lower-bit or approximate changes, add perplexity and representative chat-quality gates rather than requiring bit-identical token output.

## Optimization ladder

The ranges below are experiment milestones, not guaranteed cumulative gains.

| Stage | Throughput milestone | Main work |
|---|---:|---|
| Baseline | 60 tok/s | Current implementation |
| Dispatch hygiene | 65–75 tok/s | Remove unnecessary fills, casts, allocations, and readbacks |
| Specialized GEMV | 90–125 tok/s | Accelerate FFN-down and the Q6_K vocabulary head |
| Fused decode graph | 125–175 tok/s | Native GQA attention and broader operation fusion |
| Algorithmic acceleration | 200+ tok/s | Batched verification and speculative decoding |

## 1. Remove avoidable hot-path work

Several buffers are initialized even though the following kernel overwrites them completely:

- Embedding gather creates zeroed F32 storage, casts it to F16, overwrites it, and casts back to F32.
- The fused vocabulary argmax creates zeroed partial-value, partial-ID, and output buffers every token.
- Host token tensors and other scratch tensors are recreated repeatedly.

Ideas:

- Allocate correctly typed `empty` output buffers at the primitive level.
- Keep persistent embedding, projection, attention, and argmax scratch buffers in the model.
- Avoid F16/F32 casts around embedding gather when the next consumer can accept the gathered type directly.
- Add bounded KV checkpoints so 4–8 device-resident greedy steps can run before CPU readback and then rewind if an EOS or turn marker appeared.

A device-resident greedy prototype measured about +2.8% by itself. Reintroduce it only alongside bounded KV rewind or batched verification; it cannot reach 200 tok/s alone.

## 2. Specialize the dominant GEMV kernels

### Q4_0 FFN-down

FFNs account for 62% of active weight bytes. Wide FFN-down has 1,536 output rows and 12,288 input columns and currently reaches only about 156 GB/s.

Experiments:

- Split each long output row across multiple SIMD groups, followed by a small reduction.
- Tune the number of SIMD groups per row independently for 6,144- and 12,288-column projections.
- Use vectorized packed-weight loads.
- Replace manual IEEE half decoding with native Metal `half` conversion where possible.
- Prepack weights into an Apple-GPU-oriented lane layout during model load.
- Autotune gate/up and down shapes independently instead of using one geometry for every Q4 matrix.

### Q6_K vocabulary argmax

The 330 MB tied vocabulary head is 23.5% of active bytes and currently takes about 1.89 ms. Its target should be below 1 ms.

Experiments:

- Vectorize Q6 bit unpacking and scale loads.
- Use native half conversion for block scales.
- Autotune the current 1,024-row argmax tile size.
- Reuse persistent partial-value and partial-ID buffers.
- Explore a single-stage or hierarchical SIMD reduction with fewer global writes.
- Test a Q4 vocabulary head while keeping quality gates, since the embedding and output head are tied.

### Other projection work

- Implement a native F16 GEMV for the 27.5 MB PLE context projection.
- Fuse Q, K, and V into one packed projection for the 15 layers that own KV state.
- Use shape-specialized kernels for the small K/V and attention-output projections, where launch overhead and low occupancy matter more than peak bandwidth.

## 3. Replace generic attention with native GQA attention

The current decode path repeats the single K/V head across eight query heads, materializes scores, invokes generic softmax, and performs a second generic matrix multiplication.

A native Metal kernel should:

- Consume the single KV head directly for all eight query heads.
- Reuse each K/V value across query-head calculations rather than materializing an eightfold repeat.
- Compute online softmax without writing the full score matrix.
- Read the local ring buffer in logical order without `Tensor::cat` when it wraps.
- Append new K/V state and attend from it with minimal dispatches.
- Write the attended vector directly into the attention-output projection input.

KV storage experiments:

- Move the cache from F32 to F16 first.
- Evaluate FP8 KV only after F16 correctness and quality are established.
- Report throughput at multiple contexts, because compressed KV matters much more at 8K–128K than at 256 tokens.

This work is essential for reducing the observed decline from 68.2 tok/s at near-empty context to 55.3 tok/s at approximately 1K context.

## 4. Fuse the decode graph

Promising fusion boundaries:

- Input RMSNorm plus QKV projection preparation.
- Q/K normalization plus RoPE.
- GeGLU evaluation inside the FFN-down kernel, avoiding a separate activated FFN buffer.
- PLE GELU and elementwise multiplication inside the PLE projection consumer.
- Residual add, RMSNorm, and layer scalar multiplication.
- Final RMSNorm directly into the fused vocabulary-head argmax.

The FFN gate and up projections are already stacked into one GEMV, so the next major FFN opportunity is eliminating the intermediate work between gate/up and down.

Where whole-operation fusion is impractical, persistent scratch allocation and fewer command-encoder boundaries can still reduce launch gaps.

## 5. Build true batched prefill

Current prefill is single-token decode in a loop. Implement a multi-token forward path with:

- Sequence-by-hidden QMM kernels.
- Causal local/global attention over a token block.
- Bulk KV insertion.
- Chunk sizes tuned for 8, 16, 32, 64, and larger prompt blocks.
- Correct handling of the local ring and shared KV producers.

This should greatly improve time-to-first-token. More importantly, short batched forward passes are required for efficient speculative verification.

## 6. Add speculative decoding

If optimized single-token decode stalls below roughly 170 tok/s, speculative decoding is the strongest path to 200+ accepted output tok/s.

Suggested sequence:

1. Implement batched target verification.
2. Add an n-gram-cache draft source, which requires no second neural model.
3. Measure acceptance on chat, reasoning, and code prompts separately.
4. Test a small compatible draft model or trained speculator if n-gram acceptance is insufficient.
5. Draft 4–8 tokens, verify them in one target batch, and adapt the draft length from recent acceptance.
6. Preserve exact greedy output by emitting only target-confirmed tokens.

Track all of the following:

- Accepted tokens per verification.
- Draft-generation time.
- Target-verification time.
- Rollback frequency.
- End-to-end accepted tok/s.
- Performance when acceptance is poor.

Speculation only helps if verifying a short batch is much cheaper than decoding the same tokens serially, so it should not be attempted before true batched prefill exists.

## 7. Lower-bit formats if more margin is needed

Potential experiments:

- Q4_0 or another 4-bit format for the tied vocabulary head.
- Q3_K or an importance-aware 3-bit format for the largest FFN matrices.
- Keep attention, norms, embeddings, or selected sensitive layers at higher precision.
- Quantize the F16 PLE context projection.

Lower-bit weights reduce both storage and per-token memory traffic, but they change model quality. Treat each format as a model variant with its own perplexity and task-quality report.

## 8. Use other runtimes as performance oracles

Benchmark the same Gemma 4 E2B model through current MLX-LM and, if supported by the pinned checkpoint, llama.cpp.

The purpose is not necessarily to replace QuixiChat's native engine. It is to answer two questions quickly:

- Can this exact model and hardware combination already approach 200 tok/s in another optimized runtime?
- Which operations and kernel strategies account for the difference?

If another runtime reaches the goal, capture its operation profile and port the relevant ideas. If every mature runtime is far below 200, prioritize speculative decoding or lower-bit weights over minor dispatch tuning.

## Work unlikely to move model tok/s

Do not prioritize these for the 200 tok/s goal:

- UI rendering or CSS.
- SSE chunk coalescing.
- HTTP routing.
- Tokenizer speed during steady-state decode.
- CPU thread-count tuning.
- Additional Rust LTO or codegen flags.
- Model download or load-time improvements.

They may improve startup or perceived smoothness, but they are outside the measured decode loop.

## Recommended first experiments

1. Add stable median reporting and GPU timestamp/counter capture.
2. Replace overwritten zero buffers with persistent typed scratch allocations.
3. Profile one complete token by kernel category and dispatch count.
4. Tune the wide FFN-down kernel to at least 250–300 GB/s.
5. Reduce the Q6_K vocabulary head from 1.89 ms toward 1 ms.
6. Implement native GQA decode attention without K/V repetition or score materialization.
7. Rebenchmark; if throughput remains below about 170 tok/s, move directly to batched verification and speculation.

## References

- [Apple MacBook Pro technical specifications](https://www.apple.com/macbook-pro/specs/)
- [Apple GPU performance counters](https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-counter-statistics)
- [llama.cpp speculative decoding](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md)
- [MLX-LM](https://github.com/ml-explore/mlx-lm)
