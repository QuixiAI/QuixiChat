import { MODEL_LOCK } from '@quixi/quixi-embed';
import type { ChunkTokenizerAdapter } from '@quixi/quixi-embed';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import scalarWasmUrl from '@quixi/quixi-embed/artifacts/1.0.2/quixi-scalar.wasm?url';
import tokenizerUrl from '@quixi/quixi-embed/artifacts/model/arctic-xs.qxtokenizer?url';
import { ChunkTokenizerError, createStorageChunkTokenizer } from './search/tokenizer.ts';

async function fetchPinned(url: string, expected: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new ChunkTokenizerError(`Tokenizer asset ${url} is unavailable (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new ChunkTokenizerError(`Tokenizer asset ${url} exceeds its pinned size.`);
  if (bytesToHex(sha256(bytes)) !== expected) throw new ChunkTokenizerError(`Tokenizer asset ${url} does not match its pinned SHA-256.`);
  return bytes;
}
let loading: Promise<ChunkTokenizerAdapter> | undefined;
/** One verified tokenizer per Storage Worker, loaded from bundled assets. It
 * needs no model weights; a failure is reported as a typed derived-search
 * initialization outcome and never blocks canonical access. */
export function loadChunkTokenizer(): Promise<ChunkTokenizerAdapter> {
  if (!loading) {
    loading = (async () => {
      const [wasm, tokenizer] = await Promise.all([
        fetchPinned(scalarWasmUrl, MODEL_LOCK.wasm.scalar.sha256, 4 * 1024 * 1024),
        fetchPinned(tokenizerUrl, MODEL_LOCK.tokenizer.sha256, MODEL_LOCK.tokenizer.bytes),
      ]);
      return createStorageChunkTokenizer({ wasm, tokenizer });
    })();
    loading.catch(() => { loading = undefined; });
  }
  return loading;
}
