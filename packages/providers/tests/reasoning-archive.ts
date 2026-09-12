import type { ArchiveJobStatus, StorageClient } from '@quixi/core/contracts';
const id = () => crypto.randomUUID();
/** Synthetic provider output through production archive jobs. The existing
 * query-only worker inspects the isolated candidate without activating it. */
export async function roundTripReasoning(client: StorageClient, blobs: { sha256: string; byteLength: number }[]) {
  if (blobs.length !== 2) throw new Error('Expected both synthetic reasoning receipts');
  const before = await client.request(id(), 'diagnostics', null);
  let steps = 0, peakTransferBytes = 0;
  async function advance(job: ArchiveJobStatus) {
    while (job.state === 'working') {
      if (++steps > 10000) throw new Error('Reasoning archive exceeded step bound');
      job = await client.request(id(), 'advanceArchiveJob', { operationId: id(), jobId: job.jobId, maxRecords: 8, maxBytes: 262144 });
    }
    if (job.state !== 'ready') throw new Error('Reasoning archive failed: ' + JSON.stringify(job.failure));
    return job;
  }
  const exported = await advance(await client.request(id(), 'beginArchiveExport', { operationId: id(), format: 'portable' }));
  const output = await client.request(id(), 'openArchiveExport', { jobId: exported.jobId });
  const restore = await client.request(id(), 'beginArchiveRestore', { operationId: id(), expectedBytes: output.byteLength, expectedSha256: output.sha256 });
  let offset = 0, sequence = 0;
  for (;;) {
    const chunk = await client.readChunk(output.transferId);
    if (chunk.sequence !== sequence++ || chunk.offset !== offset || chunk.bytes.length > 65536 || chunk.bytes.length > restore.inputTransfer.maxChunkBytes) throw new Error('Malformed reasoning archive transfer');
    peakTransferBytes = Math.max(peakTransferBytes, chunk.bytes.length);
    const ack = await client.sendChunk({ ...chunk, transferId: restore.inputTransfer.transferId, bytes: chunk.bytes.slice() });
    offset += chunk.bytes.length;
    if (ack.committedOffset !== offset) throw new Error('Incomplete reasoning archive upload');
    await client.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: offset });
    if (chunk.final) break;
  }
  if (offset !== output.byteLength) throw new Error('Truncated reasoning archive');
  const restored = await advance(await client.request(id(), 'finishArchiveRestore', { operationId: id(), jobId: restore.job.jobId, byteLength: output.byteLength, sha256: output.sha256 }));
  const candidate = restored.candidate;
  if (!candidate) throw new Error('Missing reasoning archive candidate');
  const after = await client.request(id(), 'diagnostics', null);
  if (before.canonicalRecords !== after.canonicalRecords || before.syncOperations !== after.syncOperations) throw new Error('Reasoning round trip changed active canonical history');
  for (const job of [exported, restored]) await client.request(id(), 'releaseArchiveJob', { operationId: id(), jobId: job.jobId });
  await client.close();
  const retained = [];
  for (const blob of blobs) {
    const reader = new Worker(new URL('../../storage/tests/archives/browser-worker.ts', import.meta.url), { type: 'module' });
    try {
      const value = await new Promise<{ canonicalRecords: number; syncOperations: number; integrity: string; blobBytes: number; blobSha256: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Reasoning candidate inspection deadline')), 30000);
        reader.onmessage = ({ data }) => { clearTimeout(timer); data.ok ? resolve(data.result) : reject(new Error(data.error)); };
        reader.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        reader.postMessage({ command: 'inspect-retained-candidate', archiveId: candidate.archiveId, digest: blob.sha256 });
      });
      if (value.integrity !== 'ok' || value.canonicalRecords !== before.canonicalRecords || value.syncOperations !== before.syncOperations || value.blobSha256 !== blob.sha256 || value.blobBytes !== blob.byteLength) throw new Error('Restored reasoning receipt or canonical inventory differs');
      retained.push(value);
    } finally { reader.terminate(); }
  }
  return { archiveBytes: output.byteLength, archiveSha256: output.sha256, peakTransferBytes, steps, candidate, retained };
}
