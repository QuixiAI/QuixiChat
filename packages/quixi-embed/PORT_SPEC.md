# Arctic XS port contract — v1

**Frozen reference:** 2026-09-08. The source, tokenizer, graph, roles, and numerical
gates below are fixed. The C scalar encoder/tokenizer and v1 `.qxmodel`/`.qxtokenizer` formats are now
implemented in plan 17. WASM SIMD and WebGPU optimization gates remain in plans
18–19. See [scalar evidence](tests/reports/README.md) for validated execution scope.

## Source identity and licensing

The source is [Snowflake/snowflake-arctic-embed-xs, revision
d8c86521100d3556476a063fc2342036d45c106f](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/tree/d8c86521100d3556476a063fc2342036d45c106f).
The FP32 `model.safetensors` is 90,272,656 bytes, SHA-256
`ee789e0b1d6ecbbd5ce37b474af556cc1a1319cee4417d9e3b11f82e90300706`.
[The source lock](reference/source-lock.json) records byte lengths and SHA-256 for
all eleven required model, tokenizer, configuration, and model-card artifacts.
Downloads are revision-addressed, verified before use, and kept under ignored
`build/source`. Neither a moving `main` revision nor an ONNX conversion is accepted.

Upstream declares Apache-2.0 in the pinned model card. The repository snapshot
contains no separate LICENSE file; [the standard license text](reference/LICENSE-Arctic.txt)
is included for redistribution. Preserve upstream attribution and the model card
when distributing converted weights. Corpus text and hand-authored input fixtures
are original synthetic material, dedicated under [CC0-1.0](../../perf/retrieval/LICENSE.txt).
Numerical arrays derive from the Apache-2.0 model; their manifest preserves attribution.

## Dimensions and complete tensor inventory

[The inventory](tests/goldens/tensor-inventory.json) records every tensor name,
shape, dtype, element count, and raw little-endian tensor SHA-256. There are
**101 FP32 tensors, 22,565,376 parameters**, with no pooler weights. Dimensions:

| Quantity | Value |
| --- | --- |
| Vocabulary | 30,522 |
| Hidden / output width | 384 |
| Encoder layers | 6 |
| Attention heads / head width | 12 / 32 |
| FFN intermediate width | 1,536 |
| Position embeddings / maximum input | 512 / 512 tokens including specials and prefix |
| Token type embeddings | 2; public single-text API always supplies type 0 |
| LayerNorm epsilon | 1e-12, inside square root |
| Final normalization epsilon | 1e-12, lower bound on L2 norm |

Checkpoint matrices are row-major `[output,input]`: evaluate `X @ W.T + bias`.
Embedding tables are `[vocabulary,384]`, `[512,384]`, and `[2,384]`. Embedding
LayerNorm has learned `[384]` scale and bias. Each layer has Q/K/V `[384,384]`
weights and `[384]` biases, attention-output projection of the same shape,
attention-output LayerNorm `[384]` scale/bias, FFN input `[1536,384]` weight and
`[1536]` bias, FFN output `[384,1536]` weight and `[384]` bias, and final LayerNorm
`[384]` scale/bias. The inventory is authoritative; the compiler must reject
missing, extra, reshaped, or non-FP32 source tensors.

## Fixed forward graph

The offline oracle is `BertModel(add_pooling_layer=False)`, eval mode, eager
attention, CPU FP32. Training dropout is disabled. The pinned upstream
[implementation source hashes](reference/runtime-source-lock.json) identify the
BERT and tokenizer semantics inspected for this contract.

For batch `B`, padded length `T <= 512`, and hidden dimension `D=384`:

1. Sum word, absolute position `0..T-1`, and token-type embeddings, then apply
   embedding LayerNorm across D. Variance is the population variance, not the
   sample variance. This is golden `stage_0`.
2. In each of six layers, form biased Q/K/V projections. Reshape
   `[B,T,384] -> [B,T,12,32] -> [B,12,T,32]`. Each head attends to all real tokens
   in that sequence; there is no causal mask, rotary embedding, or KV cache.
3. Scores are `Q @ K.T / sqrt(32)`. Add the key padding mask: zero for real keys,
   the minimum finite FP32 value for padding in the FP32 reference. Softmax is
   over keys, with max subtraction. Padding query rows are still computed; masks
   do not erase their hidden states. Implementations may use mathematically
   equivalent negative infinity masking if all numerical gates pass.
4. Multiply attention probabilities by V; transpose and concatenate heads back
   to `[B,T,384]`. Apply the biased output projection, residual addition from the
   layer input, and attention-output LayerNorm.
5. Apply the biased FFN input projection, exact GELU
   `x * (1 + erf(x / sqrt(2))) / 2`, and biased FFN output projection. Add the
   attention-output residual and apply the final LayerNorm. This is `stage_1`
   through `stage_6`. A tanh GELU approximation is an optimization requiring gates.
6. Pool the **first/CLS token** of `stage_6`; no mean pooling or tanh pooler.
   Divide the 384-vector by `max(sqrt(sum(x*x)), 1e-12)`. Output FP32 vectors in
   original request order even when a backend uses FP16 intermediate values.

## Exact tokenizer and roles

The authority is the frozen `tokenizer.json`, vocabulary, special-token config,
and **fast tokenizers 0.21.0** behavior. Do not silently substitute the slow
Python BERT tokenizer: Unicode normalization order differs in implementation.

- Documents receive no prefix. Queries prepend the exact UTF-8 string
  `Represent this sentence for searching relevant passages: `, including the
  final ASCII space. Its eight WordPiece IDs are
  `[5050,2023,6251,2005,6575,7882,13768,1024]`. Prefixing occurs before normalization
  and truncation. An empty query has ten total IDs; an empty document has two.
- Recognize the five added special token strings as configured, including literal
  occurrences inside user text. They are case-sensitive, not normalized, do not
  consume adjacent whitespace, and are not restricted to whole words.
- For ordinary text, clean NULL, U+FFFD, and Unicode control/format/private-use characters (Cc, Cf, Co), except
  tab/newline/carriage return. The pinned runtime preserves unassigned characters
  such as U+0378; the upstream source comment claiming Cn removal is broader than
  its actual dependency behavior. Replace recognized whitespace with
  ASCII space. Surround Chinese code points in the pinned normalizer ranges
  with spaces: 4E00–9FFF, 3400–4DBF, 20000–2A6DF, 2A700–2B73F, 2B740–2B81F,
  2B920–2CEAF, F900–FAFF, and 2F800–2FA1F. These are inclusive hexadecimal ranges.
- **NFD and remove nonspacing marks first, then Unicode lowercase.** This follows
  the inspected fast normalizer order. Split on whitespace and isolate ASCII
  punctuation plus Unicode punctuation. Do not replace these operations with
  locale-dependent C functions or ASCII-only normalization.
- WordPiece uses greedy longest matching vocabulary substrings, `##` for
  noninitial pieces, and whole-word `[UNK]` if segmentation fails. A word with
  more than 100 Unicode characters maps to `[UNK]`.
- Add `[CLS]=101` and `[SEP]=102`; `[PAD]=0`, `[UNK]=100`, `[MASK]=103`.
  Right-truncate content to leave room for the two framing tokens (510 content
  IDs, including any query prefix). No truncation stride. Right-pad each batch
  to its longest truncated sequence with ID/type 0 and mask 0; real tokens have
  mask 1. Public APIs accept one text per item; sentence-pair mode is not exposed.
- The C tokenizer must own vocabulary and Unicode behavior. Generated Unicode
  tables must be checked against the pinned fast tokenizer, including scripts,
  accents, format/private/unassigned characters, punctuation, and expansions.
  The offline tokenizer is a test oracle, never a browser runtime dependency.

## Golden coverage and numerical gates

[159 cases](tests/goldens/manifest.json) include empty/short strings, composed and
decomposed accents, non-Latin scripts, emoji, control characters, code,
punctuation, literal special tokens, overlong words, truncation at 512, both
roles, and right-padded mixed batches. Batch sizes are **1, 4, 8, 16, 32**.
Boundary lengths are **2, 3, 7, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256,
257, 511, 512** where role semantics permit. Every case contains all IDs, masks,
type IDs, unnormalized CLS, and final vectors. Selected edge, mixed-padding,
and full-length cases also contain every element of all seven hidden stages.

[compare.py](reference/compare.py) is the executable gate. It rejects missing
cases/stages, changed input/source identities, hash failures, shape changes,
nonfinite values, and any nonexact tokenizer IDs/masks/types. Its predeclared
limits are:

| Route | Hidden/pooled atol / rtol | Final max abs | Minimum cosine | Unit-norm abs |
| --- | --- | --- | --- | --- |
| Scalar FP32 | 1e-4 / 1e-4 | 2e-5 | 0.999999 | 1e-5 |
| WASM SIMD FP32 | 2e-4 / 2e-4 | 5e-5 | 0.999999 | 2e-5 |
| WebGPU FP32 | 3e-4 / 3e-4 | 8e-5 | 0.999999 | 3e-5 |
| WebGPU FP16 | 3e-2 / 2e-2 | 3e-3 | 0.9999 | 1e-3 |

These are acceptance limits, not claims that unimplemented backends pass. Every
retained dispatch specialization must be forced through its own route with the
entire applicable batch/length matrix. New tile boundaries require fixtures at
boundary minus one, boundary, and boundary plus one before enabling dispatch.
Do not average away a failing vector or skip an unsupported route as a pass.
Keep scalar diagnostics even when a fused backend only exposes stage snapshots
in a diagnostic build. Changes to tolerances require a recorded decision and
numerical plus retrieval evidence, not just acceptance of an optimization.

## Retrieval and performance gates

[The independent retrieval harness](../../perf/retrieval/README.md) records
Recall@5/10, full-ranking MRR, judged Recall@100/500, and binary coarse candidate
overlap with exact FP32 chunk neighbors. Its original 655-document, 18-query
corpus includes 659 reference chunks, long assistant text whose relevant passage
occurs beyond 512 tokens, code, similar distractors, provider changes, and PDF-like
passages. Judgments were authored before scores. This is a reproducible smoke
baseline; a larger reviewed relevance corpus remains necessary before selecting
production compression or claiming representative quality.

Candidate inference must pass numerical gates separately from retrieval. On this
frozen corpus, require no reduction in aggregate Recall@5, Recall@10, or MRR from
the exact FP32 baseline; investigate every changed top-ten result. Compression
selection additionally requires the broader quality/scale gate in plan 21.

Report cold process/model load separately from warm execution, tokenization,
transfer, dispatch, and readback. Measure all five batch sizes for WASM SIMD,
WebGPU FP32, and FP16, lengths 32/128/512 plus dispatch boundaries; use mixed
lengths for scheduler tests. Production comparisons require five warmups and at
least 30 measured samples per configuration, median/p95, CPU/GPU/browser/device
identity, memory and allocator peaks, and alternating before/after runs. The
checked-in offline baseline has three CPU samples per configuration and is
explicitly preliminary; it makes no WASM/GPU performance claim.

## Implementation language and reproduction

Use **C11** for the scalar and WASM SIMD implementation, with a flat C ABI and
explicit contiguous buffers. [Decision 0003](../../docs/decisions/0003-arctic-xs-port.md)
records the rationale and measured native/WASM interop proof. No BLAS, native
server, or desktop-only numerical dependency enters the production runtime.

Follow [reference/README.md](reference/README.md) to reproduce the checked-in
outputs. Offline PyTorch/Transformers dependencies are confined to reference
scripts; they are not npm dependencies or shipped browser assets.

## Original-source offsets — CPU 1.0.2

The independently usable tokenizer now exposes bounded, untruncated original
UTF-8/UTF-16 provenance, with separate source/query-prefix/framing origins.
[The offset contract](src/TOKEN_OFFSETS.md) defines capacities, exact required-count
errors, overlapping spans and removed-source gaps. Token IDs, normalization,
model format and numerical gates above remain unchanged. The original contributor
ranges deliberately differ from 16 frozen-upstream offset-metadata cases where
mixed combining marks exclude surviving original characters. Hand-specified
contributors and pinned normalization/IDs verify those cases; universal upstream
offset parity is not claimed. A final source slice must be independently
re-inspected before semantic admission. Shared structural/FTS chunking remains
model-independent.
