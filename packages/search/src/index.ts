export { StructuralChunker, chunkText, LEXICAL_CHUNKER_VERSION } from './chunker.ts';
export type { ChunkPosition, LocatedSearchChunk, ChunkSource, ChunkPolicy, ChunkTokenizer } from './chunker.ts';
export { lexicalQuery, searchExcerpt, searchDigest, SearchError, CodeChunkClassifier } from './query.ts';
export { fuseRanked, RRF_K } from './fusion.ts';
export type { FusedItem } from './fusion.ts';
export { createSemanticIndexer } from './semantic/indexer.ts';
export type { EmbeddingClient, EmbeddingRuntimeStatistics, SemanticIndexer, SemanticIndexerOptions, SemanticIndexerSnapshot } from './semantic/indexer.ts';
