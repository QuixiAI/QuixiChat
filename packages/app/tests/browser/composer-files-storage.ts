import type { StorageClient } from '@quixi/core/contracts';

/** Read synthetic attachment bytes through the real bounded worker protocol. */
export async function attachmentFingerprint(storage: StorageClient, sha256: string) {
  const transfer = await storage.request(crypto.randomUUID(), 'readBlobTransfer', { sha256 });
  if (transfer.byteLength > 2_621_440) throw new Error('Composer fixture blob exceeds its reviewed bound');
  const bytes = new Uint8Array(transfer.byteLength);
  let offset = 0;
  for (let step = 0; step < 42; step++) {
    const chunk = await storage.readChunk(transfer.transferId);
    if (chunk.offset !== offset || chunk.bytes.length > 65536 || offset + chunk.bytes.length > bytes.length) throw new Error('Unexpected composer blob window');
    bytes.set(chunk.bytes, offset); offset += chunk.bytes.length;
    await storage.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: offset });
    if (chunk.final) {
      if (offset !== bytes.length) throw new Error('Incomplete composer blob');
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      return { sha256: actual, byteLength: offset };
    }
  }
  throw new Error('Composer fixture exhausted its bounded blob reads');
}
