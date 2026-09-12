import { createArcticTokenizer, createChunkTokenizer, MODEL_LOCK } from '@quixi/quixi-embed';
import type { ChunkTokenizerAdapter } from '@quixi/quixi-embed';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export class ChunkTokenizerError extends Error {
  constructor(message: string) { super(message); this.name = 'ChunkTokenizerError'; }
}
/** Build the shared chunk tokenizer from verified bytes (Node fixtures and workers). */
export async function createStorageChunkTokenizer(assets: { wasm: Uint8Array; tokenizer: Uint8Array }): Promise<ChunkTokenizerAdapter> {
  if (bytesToHex(sha256(assets.wasm)) !== MODEL_LOCK.wasm.scalar.sha256) throw new ChunkTokenizerError('Tokenizer WASM does not match its pinned SHA-256.');
  if (bytesToHex(sha256(assets.tokenizer)) !== MODEL_LOCK.tokenizer.sha256) throw new ChunkTokenizerError('Tokenizer artifact does not match its pinned SHA-256.');
  const tokenizer = await createArcticTokenizer({ wasm: assets.wasm, tokenizer: assets.tokenizer });
  return createChunkTokenizer(tokenizer, { runtimeVersion: MODEL_LOCK.runtimeVersion, tokenizerSha256: MODEL_LOCK.tokenizer.sha256 });
}
