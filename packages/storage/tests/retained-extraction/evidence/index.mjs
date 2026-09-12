import { openActiveStorageClient, readArchiveSelection, readRetainedArchive, reconcilePreviousArchiveExtraction } from '../../src/client/index.ts';
import { DOCUMENT_EXTRACTION_VERSIONS, canonicalJson } from '@quixi/core/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
const id = () => crypto.randomUUID(), hash = value => bytesToHex(sha256(new TextEncoder().encode(value)));
const outcome = async action => { try { return { ok: true, result: await action() }; } catch (error) { return { ok: false, code: error.code, message: error.message }; } };
let client, fixture, beforeFirstRead, closeCalls = 0;
const request = (operation, args = null) => client.request(id(), operation, args);
async function privateCall(command, archiveId, operationId, targetId) {
  const shared = ['snapshot', 'clone'].includes(command);
  const worker = shared ? new Worker(new URL('../retained/fixture-worker.mjs', import.meta.url), { type: 'module' }) : new Worker(new URL('./fixture-worker.mjs', import.meta.url), { type: 'module' });
  try { return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Private receipt fixture deadline')), 15000);
    worker.onmessage = ({ data }) => { clearTimeout(timer); data.ok ? resolve(data.result) : reject(new Error(data.error)); };
    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
    worker.postMessage({ command, archiveId, operationId, targetId });
  }); } finally { worker.terminate(); }
}
async function advance(job) {
  for (let count = 0; job.state === 'working'; count++) {
    if (count > 2000) throw new Error('Archive fixture step bound');
    job = await request('advanceArchiveJob', { operationId: id(), jobId: job.jobId, maxRecords: 16, maxBytes: 262144 });
  }
  if (job.state !== 'ready') throw new Error(JSON.stringify(job)); return job;
}
window.extractionReceiptProof = {
  async seed() {
    client = await openActiveStorageClient();
    const workspace = await request('archiveWorkspace'), bytes = new TextEncoder().encode('%PDF-1.7\nRetained receipt fixture\n'), digest = bytesToHex(sha256(bytes));
    const upload = await request('beginBlobTransfer', { operationId: id(), purpose: 'document', expectedBytes: bytes.length, expectedSha256: digest });
    const size = bytes.length;
    await client.sendChunk({ transferId: upload.transferId, sequence: 0, offset: 0, bytes, final: true });
    await request('finishBlobTransfer', { operationId: id(), transferId: upload.transferId, expectedBytes: size, expectedSha256: digest });
    const attachmentId = id(), documentId = id(), canonicalId = id(), now = Date.now();
    await request('commit', { transactionId: id(), stagedBlobIds: [upload.transferId], expectedThreadRevisions: [], mutations: [
      { version: 1, operationId: canonicalId, kind: 'RegisterAttachment', recordedAt: now, payload: { attachment: { id: attachmentId, filename: '日本語\u0000.pdf', mimeType: 'application/pdf', availability: 'available', sizeBytes: size, blobSha256: digest, rawObjectId: null } } },
      { version: 1, operationId: id(), kind: 'RegisterDocument', recordedAt: now, payload: { document: { id: documentId, workspaceId: workspace.workspaceId, attachmentId, title: 'Retained 日本語\u0000receipt', createdAt: now, recordedAt: now, importSourceId: null } } },
    ] });
    const args = { operationId: id(), identity: { documentId, attachmentId, attachmentSha256: digest, attachmentByteLength: size, ...DOCUMENT_EXTRACTION_VERSIONS } };
    const result = await request('beginDocumentExtraction', args);
    fixture = { operationId: args.operationId, requestDigest: hash(canonicalJson({ operation: 'beginDocumentExtraction', args })), canonicalId, documentId, result, selection: client.selection };
    return fixture;
  },
  sameSelection() { return outcome(() => reconcilePreviousArchiveExtraction(client, { operationId: fixture.operationId, requestDigest: fixture.requestDigest })); },
  diagnostics() { return request('diagnostics'); },
  async activate() {
    const exported = await advance(await request('beginArchiveExport', { operationId: id(), format: 'portable' }));
    const transfer = await request('openArchiveExport', { jobId: exported.jobId });
    const restore = await request('beginArchiveRestore', { operationId: id(), expectedBytes: transfer.byteLength, expectedSha256: transfer.sha256 });
    for (;;) {
      const chunk = await client.readChunk(transfer.transferId), length = chunk.bytes.length;
      await client.sendChunk({ ...chunk, transferId: restore.inputTransfer.transferId, bytes: chunk.bytes.slice() });
      await client.acknowledgeChunk({ transferId: transfer.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + length });
      if (chunk.final) break;
    }
    await request('releaseArchiveJob', { operationId: id(), jobId: exported.jobId });
    const candidate = await advance(await request('finishArchiveRestore', { operationId: id(), jobId: restore.job.jobId, byteLength: transfer.byteLength, sha256: transfer.sha256 }));
    const context = await request('readArchiveActivationContext');
    const review = await request('prepareArchiveActivation', { operationId: id(), jobId: candidate.jobId, expectedActiveArchiveId: context.selection.archiveId, expectedRevision: context.expectedRevision });
    const activated = await request('activateRestoredArchive', { operationId: id(), expectedSelection: context.selection, review });
    const originalClose = client.close.bind(client);
    client.close = async () => { closeCalls++; await originalClose(); beforeFirstRead ??= await privateCall('snapshot', 'default'); };
    return activated;
  },
  reconcile(operationId = fixture.operationId, requestDigest = fixture.requestDigest) { return outcome(() => reconcilePreviousArchiveExtraction(client, { operationId, requestDigest })); },
  read(archiveId, operationId = fixture.operationId) { return outcome(() => readRetainedArchive(archiveId, id(), 'getExtractionOperation', { operationId })); },
  mutation() { return outcome(() => readRetainedArchive('default', id(), 'beginDocumentExtraction', { operationId: id(), identity: fixture.result.identity })); },
  selection: () => readArchiveSelection(),
  before: () => ({ files: beforeFirstRead, closeCalls }),
  snapshot: archiveId => privateCall('snapshot', archiveId),
  async variant(command) {
    const archiveId = id();
    if (!command.startsWith('legacy')) await privateCall('clone', 'default', undefined, archiveId);
    const state = await privateCall(command, archiveId, fixture.operationId);
    return { archiveId, state };
  },
};
