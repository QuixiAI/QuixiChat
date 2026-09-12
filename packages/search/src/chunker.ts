import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SearchChunk } from '@quixi/core/model';
import type { ChunkPosition, LocatedSearchChunk } from '@quixi/core/contracts';
export type { ChunkPosition, LocatedSearchChunk } from '@quixi/core/contracts';

/** Lexical working-set policy, not a model token-count or semantic tuning choice. */
export const LEXICAL_CHUNKER_VERSION = 'quixi-structural-utf16-v1';
export interface ChunkSource {
  sourceType: SearchChunk['sourceType']; sourceId: string; partId: string | null;
  sourceDigest: string; contextPrefix: string;
  page?: number | null; sectionPath?: string[]; offsetBase?: number;
}
/** Token offsets must cover the complete input. Truncated encoder token IDs are
 * deliberately not accepted as a tokenization interface. No model is loaded here.
 */
export interface ChunkTokenizer {
  version: string;
  offsets(text: string): readonly { start: number; end: number }[];
}
export interface ChunkPolicy {
  maxCharacters?: number; overlapCharacters?: number;
  tokenizer?: ChunkTokenizer; maxTokens?: number;
}
const hash = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
function safeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) return end - 1;
  if (end > 0 && end < text.length && text[end - 1] === '\r' && text[end] === '\n') return end - 1;
  return end;
}
function boundary(text: string, limit: number): { end: number; split: boolean } {
  // Prefer a section boundary even if a lower-priority boundary would fill more
  // of the window. Code delimiters are retained verbatim with source offsets.
  const priorities = [ /\n(?=#{1,6}\s)/g, /\r?\n[\t ]*\r?\n/g, /\n(?=[\t ]*(?:[-*+]\s|\d+[.)]\s))/g, /\n(?=[\t ]*(?:```|~~~))/g, /[.!?。！？](?:["'”’)]*)\s+/gu ];
  const window = text.slice(0, limit + 1);
  for (const pattern of priorities) {
    let last = 0;
    for (const match of window.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end > 0 && end <= limit) last = end;
    }
    if (last) return { end: safeEnd(text, last), split: false };
  }
  // Without model tokenization, whitespace is a lexical token boundary. A single
  // long identifier/code line still makes progress using a Unicode-safe hard cut.
  let space = 0;
  for (const match of window.matchAll(/\s+/gu)) if (match.index + match[0].length <= limit) space = match.index + match[0].length;
  return { end: safeEnd(text, space || limit), split: true };
}

/** Streaming, bounded structural chunker shared by message and document sources.
 * Consume every yielded chunk before pushing the next bounded source fragment.
 */
export class StructuralChunker {
  readonly maxCharacters: number;
  readonly overlapCharacters: number;
  readonly version: string;
  private buffer = '';
  private offset: number;
  private chunkIndex = 0;
  private finished = false;
  private highWater = 0;
  constructor(private readonly source: ChunkSource, private readonly policy: ChunkPolicy = {}) {
    this.maxCharacters = policy.maxCharacters ?? 4096;
    this.overlapCharacters = policy.overlapCharacters ?? Math.min(64, Math.floor(this.maxCharacters / 8));
    if (!Number.isSafeInteger(this.maxCharacters) || this.maxCharacters < 16 || this.maxCharacters > 65_536 || !Number.isSafeInteger(this.overlapCharacters) || this.overlapCharacters < 0 || this.overlapCharacters > this.maxCharacters / 4) throw new Error('Invalid bounded chunk policy');
    if ((policy.tokenizer === undefined) !== (policy.maxTokens === undefined) || policy.maxTokens !== undefined && (!Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 1 || policy.maxTokens > 65_536)) throw new Error('Token chunking requires an untruncated offset tokenizer and a bounded token budget');
    if (!source.sourceId || !/^[0-9a-f]{64}$/.test(source.sourceDigest) || source.contextPrefix.length > 4096 || (source.sectionPath?.length ?? 0) > 32 || source.sectionPath?.some(value => value.length > 1024)) throw new Error('Invalid bounded chunk source');
    this.offset = source.offsetBase ?? 0;
    if (!Number.isSafeInteger(this.offset) || this.offset < 0 || source.page !== undefined && source.page !== null && (!Number.isSafeInteger(source.page) || source.page < 1)) throw new Error('Invalid source position');
    this.version = `${LEXICAL_CHUNKER_VERSION}:${this.maxCharacters}:${this.overlapCharacters}:${policy.tokenizer?.version ?? 'none'}:${policy.maxTokens ?? 'none'}`;
  }
  /** Observed source-text buffer bound, excluding caller-owned input/output. */
  get peakBufferedCharacters(): number { return this.highWater; }
  *push(fragment: string): Generator<LocatedSearchChunk> {
    if (this.finished) throw new Error('Chunker is already finished');
    if (typeof fragment !== 'string' || fragment.length > 65_536) throw new Error('Source fragments must be at most 65536 UTF-16 units');
    let cursor = 0;
    while (cursor < fragment.length) {
      const count = Math.min(fragment.length - cursor, this.maxCharacters + 2 - this.buffer.length);
      this.buffer += fragment.slice(cursor, cursor + count); cursor += count;
      this.highWater = Math.max(this.highWater, this.buffer.length);
      yield* this.drain(false);
    }
  }
  *finish(): Generator<LocatedSearchChunk> {
    if (this.finished) throw new Error('Chunker is already finished');
    this.finished = true; yield* this.drain(true);
  }
  private tokenLimit(limit: number): number {
    if (!this.policy.tokenizer) return limit;
    const offsets = this.policy.tokenizer.offsets(this.buffer.slice(0, limit));
    if (offsets.length > 65_536) throw new Error('Tokenizer returned an unbounded offset array');
    let previous = 0;
    for (const token of offsets) {
      if (!Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end) || token.start < previous || token.end <= token.start || token.end > limit) throw new Error('Tokenizer returned invalid or unordered source offsets');
      previous = token.start;
    }
    const boundary = offsets[this.policy.maxTokens!];
    return boundary ? safeEnd(this.buffer, boundary.start) : limit;
  }
  private *drain(final: boolean): Generator<LocatedSearchChunk> {
    while (this.buffer.length >= this.maxCharacters + 2 || final && this.buffer.length) {
      const limit = this.tokenLimit(safeEnd(this.buffer, Math.min(this.maxCharacters, this.buffer.length)));
      if (limit < 1) throw new Error('Token budget cannot make source progress');
      const fits = final && limit === this.buffer.length;
      const cut = fits ? { end: limit, split: false } : boundary(this.buffer, limit);
      if (cut.end < 1) throw new Error('Chunk policy cannot make source progress');
      const text = this.buffer.slice(0, cut.end);
      const position: ChunkPosition = { partId: this.source.partId, start: this.offset, end: this.offset + cut.end, page: this.source.page ?? null, sectionPath: [...this.source.sectionPath ?? []] };
      if (!Number.isSafeInteger(position.end)) throw new Error('Source offsets exceed safe integer range');
      const id = hash([this.source.sourceType, this.source.sourceId, this.source.partId, this.source.sourceDigest, this.version, position.start, position.end, position.page, position.sectionPath, this.source.contextPrefix]);
      const chunk: LocatedSearchChunk = { id, sourceType: this.source.sourceType, sourceId: this.source.sourceId, partIds: this.source.partId ? [this.source.partId] : [], chunkIndex: this.chunkIndex++, text, contextPrefix: this.source.contextPrefix, sourceDigest: this.source.sourceDigest, chunkerVersion: this.version, tokenizerVersion: this.policy.tokenizer?.version ?? null, tokenStart: null, tokenEnd: null, embeddingModelId: null, embeddingStatus: 'not_indexed', position };
      let advance = cut.end;
      // Overlap only a split logical block; never add overlap at structural cuts
      // or emit a redundant overlapping tail at EOF.
      if (cut.split && cut.end < this.buffer.length) advance = safeEnd(this.buffer, Math.max(1, cut.end - this.overlapCharacters));
      if (advance < 1) advance = cut.end;
      this.buffer = this.buffer.slice(advance); this.offset += advance;
      yield chunk;
    }
  }
}
export function* chunkText(text: string, source: ChunkSource, policy?: ChunkPolicy): Generator<LocatedSearchChunk> {
  const chunker = new StructuralChunker(source, policy);
  for (let at = 0; at < text.length; at += 65_536) yield* chunker.push(text.slice(at, at + 65_536));
  yield* chunker.finish();
}
