# @quixi/search

Shared SearchChunk generation for chats and documents, query helpers, result
explanations, reciprocal rank fusion and the semantic indexing loop.

- `chunker.ts`: the single structural chunker (ADR 0007). Production injects the
  frozen Arctic offset tokenizer with a 256-token budget (ADR 0034); the policy
  and tokenizer identity are part of every chunk's version.
- `fusion.ts`: `fuseRanked` implements product §43 (RRF, k=60) with deterministic
  ties and origin explanations.
- `semantic/indexer.ts`: `createSemanticIndexer` runs bounded claim → embed →
  publish cycles against an injected `StorageClient` and `EmbeddingClient`.
  Storage decides what is missing or outdated and rejects stale results; the
  loop never writes vectors directly and never blocks lexical search.

Database retrieval and FTS/vector SQL belong to storage. Inference belongs to
QuixiEmbed. This package combines those through injected clients. Basic chunking
and lexical search work without loading embedding weights or initializing an
inference backend.

Tests: `npm run test:search` covers the chunker, fusion, the lexical repository
on the pinned SQLite WASM, the semantic storage boundary with the real tokenizer
and synthetic unit vectors, and the indexer loop with fake clients.
