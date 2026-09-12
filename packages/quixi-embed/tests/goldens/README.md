# Frozen Arctic XS goldens

`manifest.json` identifies 159 exact inputs/roles, pinned source hashes,
environment, typed array shapes, and per-file SHA-256. The three diagnostic cases
include every hidden-state element; all cases include tokenizer outputs, pooled
CLS, and normalized vectors. `tensor-inventory.json` records all source weights.

Reproduce into a separate build directory using
[the reference instructions](../../reference/README.md). Do not replace goldens
to make an implementation pass. Keep changes to sources, semantics, coverage,
and thresholds reviewable as changes to [the port contract](../../PORT_SPEC.md).
