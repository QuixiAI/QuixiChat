import type { EmbeddingRole, TokenInspection } from './scalar.ts';
import { TOKEN_ORIGIN, type ArcticTokenizer } from './tokenizer.ts';

/** Structural shape shared with the product chunker; no product package is imported here. */
export interface ChunkTokenizerAdapter {
  /** Participates in the chunking version: runtime distribution plus tokenizer artifact identity. */
  readonly version: string;
  /** Source-origin token spans over the complete input, in token order. */
  offsets(text: string): readonly { start: number; end: number }[];
  /** Exact admission check for one complete embedding input. */
  inspect(text: string, role: EmbeddingRole): TokenInspection;
  dispose(): void;
}
/** Bound on offset records for one chunker window: the frozen normalization
 * expands a scalar into at most three pieces, and windows are at most 4098
 * UTF-16 units, so 16,384 records always suffice. */
export const CHUNK_OFFSET_CAPACITY = 16_384;
export const CHUNK_TOKENIZER_VERSION_PREFIX = 'arctic-xs-offsets';
export const chunkTokenizerVersion = (identity: { runtimeVersion: string; tokenizerSha256: string }) => `${CHUNK_TOKENIZER_VERSION_PREFIX}-${identity.runtimeVersion}:${identity.tokenizerSha256.slice(0, 16)}`;

/** Adapt the owned offset tokenizer to the chunker's untruncated-offset interface. */
export function createChunkTokenizer(tokenizer: ArcticTokenizer, identity: { runtimeVersion: string; tokenizerSha256: string }): ChunkTokenizerAdapter {
  if (!/^[0-9a-f]{64}$/.test(identity.tokenizerSha256) || !/^[0-9A-Za-z.\-]{1,32}$/.test(identity.runtimeVersion)) throw new RangeError('Invalid chunk tokenizer identity');
  const version = chunkTokenizerVersion(identity);
  // Fail at construction when the artifact lacks the offset ABI.
  tokenizer.tokenizeWithOffsets('', { role: 'document', maxTokens: 8 });
  return Object.freeze({
    version,
    offsets(text: string) {
      const result = tokenizer.tokenizeWithOffsets(text, { role: 'document', maxTokens: CHUNK_OFFSET_CAPACITY });
      const spans: { start: number; end: number }[] = [];
      let previous = 0;
      for (let index = 0; index < result.tokenCount; index++) {
        if (result.origins[index] !== TOKEN_ORIGIN.source) continue;
        // Contributor ranges may overlap; cut candidates only need monotone starts.
        const start = Math.max(previous, result.utf16Offsets[index * 2]!), end = result.utf16Offsets[index * 2 + 1]!;
        if (end <= start) continue;
        spans.push({ start, end });
        previous = start;
      }
      return spans;
    },
    inspect: (text: string, role: EmbeddingRole) => tokenizer.inspect(text, role),
    dispose: () => tokenizer.dispose(),
  });
}
