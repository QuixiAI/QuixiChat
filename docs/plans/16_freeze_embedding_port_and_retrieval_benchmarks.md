# 16 — Freeze the embedding port and retrieval benchmark

**Status:** Complete — frozen reference and benchmark foundation; optimized runtime gates remain in plans 17–21.

**Workstream:** C0 — independent inference foundation

**Depends on:** None; can start from the current scaffold.

## Outcome

Establish an exact Arctic XS correctness contract and a representative retrieval benchmark before writing optimized inference code.

## Product references

- [3. Product pillars](../product.md#3-product-pillars)
- [4. V1 semantic scope: text only](../product.md#4-v1-semantic-scope-text-only)
- [51. Semantic model](../product.md#51-semantic-model)
- [52. Why Arctic Embed XS](../product.md#52-why-arctic-embed-xs)
- [53. Query/document distinction](../product.md#53-querydocument-distinction)
- [54. QuixiEmbed architecture](../product.md#54-quixiembed-architecture)
- [55. No generic inference runtime](../product.md#55-no-generic-inference-runtime)
- [56. Model port specification](../product.md#56-model-port-specification)
- [58. Fixed graph](../product.md#58-fixed-graph)
- [59. Tokenizer](../product.md#59-tokenizer)
- [82. Retrieval benchmark](../product.md#82-retrieval-benchmark)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [113. QuixiEmbed benchmarks](../product.md#113-quixiembed-benchmarks)
- [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria)

## Tasks

- [x] Freeze the snowflake-arctic-embed-xs source repository, revision, checkpoint/tokenizer files, cryptographic hashes, and licenses. Verify the expected dimensions and input limits against that source.
- [x] Complete PORT_SPEC.md with the tensor inventory, graph, layer shapes, attention layout, activations, normalization constants, pooling, and query/document prompt semantics.
- [x] Choose C or Rust for the CPU implementation based on the WASM build/interop requirements and existing expertise. Record the choice without adding native desktop-only dependencies.
- [x] Create an offline reference generator with a pinned environment. Generate tokenizer IDs/masks and stage/final numeric goldens covering Unicode, punctuation, empty/short text, maximum inputs, padding, and query/document roles.
- [x] Define numeric tolerances and acceptance methodology before optimized implementations exist. Include route, length, and batch coverage so small goldens cannot accidentally miss optimized paths.
- [x] Build a redistributable Quixi retrieval corpus with queries, relevance judgments, long assistant text, code, document passages, similar passages, and provider-switch discussions.
- [x] Implement reference Recall@5/10, MRR, coarse Recall@100/500, and reproducible latency/memory measurement procedures. Record baseline data and model/chunker identities.
- [x] Review embeddinggemma.c for bounded scheduling, caching, parity tests, and benchmark discipline; document applicable lessons without importing its Gemma graph or native server assumptions.

## Deliverables and interfaces

- Frozen packages/quixi-embed/PORT_SPEC.md, reference-generation tooling, and provenance-bearing goldens.
- A product retrieval corpus and baseline report usable before Quixi UI integration.

## Acceptance criteria

- [x] A second developer can reproduce the reference outputs from the recorded sources and environment.
- [x] Tokenizer, graph, pooling, and query/document semantics contain no unresolved inferred defaults.
- [x] The benchmark distinguishes numerical agreement from retrieval quality and covers every intended optimized route.
- [x] Reference assets contain no private user history or unlicensed corpus material.

## Implementation evidence

- Frozen revision `d8c86521100d3556476a063fc2342036d45c106f`; all eleven public
  source artifacts are downloaded and SHA-256 verified by
  [fetch.py](../../packages/quixi-embed/reference/fetch.py). The checkpoint is
  90,272,656 bytes with 101 FP32 tensors and 22,565,376 parameters.
- [PORT_SPEC.md](../../packages/quixi-embed/PORT_SPEC.md) records the complete
  graph, tokenizer normalization order, CLS pooling, query prefix, dimensions,
  tensor inventory, and independently frozen numerical thresholds. The
  [C-language decision](../decisions/0003-arctic-xs-port.md) includes actual
  native/WASM SIMD build and Node linear-memory interop evidence.
- [Reproduction instructions](../../packages/quixi-embed/reference/README.md)
  pin Python 3.11.15 and all package versions/distribution hashes. Two independent
  generation runs in the pinned local environment produced 159 matching cases;
  [the comparator report](../../packages/quixi-embed/reference/reproduction-report.json)
  records maximum absolute difference 0.0. This is local reproduction evidence,
  not a claim that another physical developer or platform was tested.
- Seven reference/comparator tests validate padding invariance, roles, truncation,
  corrupted source rejection, nonfinite/drifting candidate rejection, and missing
  coverage rejection. Four metric tests validate ranking/recall semantics.
- [The corpus and harness](../../perf/retrieval/README.md) contain 655 original
  redistributable synthetic documents, 18 authored queries/judgments, and 659
  reference chunks. [The measured baseline](../../perf/retrieval/baseline.json)
  reports exact Recall@5 0.842593, Recall@10 0.898148, MRR 0.861111, plus coarse
  candidate overlap, per-query results, batch latency, and process/vector memory.

The route acceptance matrix is established for scalar, WASM SIMD, WebGPU FP32,
and WebGPU FP16; actual production route validation remains work for plans
17–19. The synthetic corpus covers the requested content categories but is a
smoke benchmark; plan 21 still requires broader reviewed relevance and scale
measurements before choosing compression. Production shared SearchChunk parity,
WASM/GPU timing, GPU memory/dispatch/readback, and large-index performance are
explicitly unmeasured. No optimized route or production-readiness claim follows
from completion of this foundation plan.

## Boundaries and sequencing

This plan can start alongside A1. Offline reference tools may use upstream frameworks; the production browser runtime must not depend on a generic inference framework. Benchmark-driven choices remain measurements to perform, not invented performance guarantees.

[Back to the roadmap](./README.md)
