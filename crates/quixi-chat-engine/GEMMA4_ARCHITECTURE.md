# Gemma 4 E2B text architecture pin

This is the executable text-model contract for MoleculAI. It is pinned to:

- Hugging Face Transformers commit `63f32a8782cb70da3365acab16f2b67947737985`,
  `modeling_gemma4.py` and `configuration_gemma4.py`.
- `google/gemma-4-e2b-it` commit
  `9dbdf8a839e4e9e0eb56ed80cc8886661d3817cf`, especially `config.json` and
  `tokenizer.json`.
- The staged `models/gemma-4-E2B_q4_0-it.gguf`, audited into
  `testdata/gemma4-gguf-audit.json`.

The upstream sources are the authority when this file and a prose design disagree.

## E2B configuration

| Property | Pinned value |
|---|---:|
| Vocabulary | 262,144 |
| Hidden width | 1,536 |
| Decoder layers | 35 |
| Base / wide FFN | 6,144 / 12,288 |
| Query heads | 8 |
| KV heads | 1 |
| Local / global head width | 256 / 512 |
| Local window | 512 |
| PLE width per layer | 256 |
| Maximum context | 131,072 |
| RMS epsilon | 1e-6 |
| Final logit soft cap | 30 |

Layers repeat four local layers followed by one global layer. The global layers are
4, 9, 14, 19, 24, 29, and 34 (zero based). Despite an earlier provisional design
description, the checkpoint has **8 query heads to 1 KV head for both attention
types**. The differing local/global projection shapes come from the 256/512 head
widths, not from different query-head counts.

Layers 15 through 34 share KV projections. They have no K/V projection or K/V norm
tensors and use the most recent producer for their attention type: layer 13 for
local attention and layer 14 for global attention. Those same 20 layers set
`use_double_wide_mlp`, making their FFNs 12,288 wide. Layers 0 through 14 use 6,144.

## Forward order

The token stream is embedded from the tied `token_embd` table and multiplied by
`sqrt(1536)`. In parallel, the packed PLE table is gathered and multiplied by
`sqrt(256)`. A context-dependent PLE term is produced by projecting the main token
embedding from 1,536 to `35 * 256`, multiplying by `1/sqrt(1536)`, reshaping, and
RMS-normalizing each 256-wide slice. The token and context PLE terms are combined
with `1/sqrt(2)`.

Each decoder layer performs these operations in order:

1. RMSNorm in f32 over the residual stream.
2. Q projection, head-wise RMSNorm, and RoPE.
3. K/V projection for layers 0--14 only. K receives RMSNorm and RoPE; V receives
   unscaled RMS normalization. Layers 15--34 reuse the stored KV tensors for their
   attention type.
4. Causal attention with f32 softmax and a score scale of exactly `1.0`, followed
   by the output projection and post-attention RMSNorm, then a residual add.
5. Pre-FFN RMSNorm, `down(gelu_tanh(gate(x)) * up(x))`, post-FFN RMSNorm, and a
   residual add.
6. PLE injection: `proj(gelu_tanh(inp_gate(x)) * ple[layer])`, RMSNorm, and a
   residual add.
7. Multiply by the learned scalar `layer_output_scale`.

After layer 34, a final RMSNorm is followed by a tied embedding/LM-head projection.
Logits use `30 * tanh(logits / 30)`.

## Positional encoding and cache

Local layers apply ordinary RoPE to all 256 head dimensions with theta 10,000 and
retain a causal 512-token ring. Global layers have 512-wide heads and proportional
RoPE with theta 1,000,000: only the first 25 percent of rotation pairs carry a
nonzero inverse frequency, while the returned cosine/sine tensors still span the
full head width. Global KV grows append-only to the configured context limit.

The two KV producer layers used by shared layers retain full-length state for the
current decode step. Shared layers do not create independent cache entries.

## Features that are absent in E2B

The generic Gemma 4 implementation contains optional MoE/router paths, but E2B has
`enable_moe_block=false` and no expert tensors. It has no AltUp, Laurel, MatFormer,
or activation-sparsity block. `attention_k_eq_v` is false, so K and V use distinct
weights. The E2B-specific nonstandard blocks are PLE, type-wise KV sharing, and the
wide FFN in the 20 shared-KV layers.

## Checkpoint formats

The staged GGUF stores linear weights as Q4_0, token and PLE tables as Q6_K, the
packed PLE context projection as F16, and normalization/scalar tensors as F32. The
text GGUF has no `v.*`, `a.*`, or `mm.*` tensors. Its tokenizer is a 262,144-entry
byte-fallback BPE with 514,906 merges; it is not a SentencePiece Unigram model.
