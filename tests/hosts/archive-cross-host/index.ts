/** Plan 09 cross-host restore, native side: a portable archive exported by
 * the web host (bundled into this page at build time) is sent through the
 * production restore path of the Storage Worker running in the Tauri
 * WebView, validated into an isolated candidate, and the candidate is read
 * back through the retained-archive reader and hashed from OPFS. Nothing is
 * activated; the report carries digests, counts and hashes only. */
import { invoke } from '@tauri-apps/api/core';
import { createIsolatedStorageClient } from '../../../packages/storage/tests/isolated-client.ts';
import { readRetainedArchive } from '../../../packages/storage/src/client/retained-archive.ts';
import { dumpCollections, hashBlobDirectory, restorePortable, sha256Hex } from '../../../packages/storage/tests/archives/cross-host.ts';

const config = (window as Window & { __QUIXI_ARCHIVE_PROOF__?: { profile: string } }).__QUIXI_ARCHIVE_PROOF__;
const report: Record<string, unknown> & { checks: string[]; stage: string; success: boolean } = {
  status: 'running', success: false, profile: config?.profile, url: location.href, userAgent: navigator.userAgent, secureContext: isSecureContext,
  scope: 'Production Storage Worker, SQLite WASM and OPFS SAH pool inside the Tauri WebView; the portable container is the web host\'s export, restored through beginArchiveRestore/finishArchiveRestore/advanceArchiveJob and read back through the retained-archive reader.',
  checks: [], stage: 'starting',
};
const id = () => crypto.randomUUID();
const checkpoint = async (stage: string) => { report.stage = stage; await invoke('archive_cross_host_checkpoint', { report: JSON.stringify({ stage }) }); };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function main() {
  assert(config?.profile, 'Native proof needs a profile');
  const response = await fetch('./archive.portable');
  assert(response.ok, 'Bundled portable archive is missing');
  const bytes = new Uint8Array(await response.arrayBuffer());
  report.input = { byteLength: bytes.byteLength, sha256: await sha256Hex(bytes) };
  await checkpoint('archive-loaded');
  const storage = createIsolatedStorageClient({ archiveId: `test-cross-host-${config.profile}` });
  try {
    const workspace = await storage.request(id(), 'archiveWorkspace', null);
    assert(workspace.workspaceId, 'The native archive did not open');
    report.diagnostics = await storage.request(id(), 'diagnostics', null);
    await checkpoint('storage-open');
    const started = performance.now();
    const restored = await restorePortable(storage, bytes);
    report.restore = { state: restored.job.state, phases: restored.phases, advances: restored.advances, failure: restored.job.failure, candidate: restored.job.candidate, sourceSchemaVersion: restored.job.sourceSchemaVersion ?? null, ms: Math.round(performance.now() - started) };
    assert(restored.job.state === 'ready' && restored.job.candidate, `Restore ended ${restored.job.state}: ${restored.job.failure?.reason ?? 'no candidate'}`);
    report.checks.push(`the web host's portable archive restores into an isolated candidate at schema ${restored.job.candidate.schemaVersion} after ${restored.advances} bounded validation steps (${restored.phases.join(' → ')})`);
    await checkpoint('candidate-ready');
    const candidateId = restored.job.candidate.archiveId;
    const dump = await dumpCollections((operation, args) => readRetainedArchive(candidateId, id(), operation, args, { timeoutMs: 30_000 }));
    const blobs = await hashBlobDirectory(`quixi-${candidateId}`);
    report.candidateDump = { ...dump, blobs, syncOperations: restored.job.candidate.syncOperations, canonicalRecords: restored.job.candidate.canonicalRecords };
    report.checks.push(`the candidate's ${dump.records} canonical records across ${Object.keys(dump.collections).length} collections were read back through the retained reader and its ${blobs.length} blob files hashed from OPFS`);
    await checkpoint('candidate-read');
    await storage.request(id(), 'cancelArchiveJob', { operationId: id(), jobId: restored.jobId }).catch(() => {});
    report.status = 'passed'; report.success = true;
  } finally { await storage.close().catch(() => {}); }
}
main().then(
  () => invoke('archive_cross_host_report', { report: JSON.stringify(report), success: true }),
  async (error) => { report.status = 'failed'; report.error = String((error as Error)?.stack ?? error); await invoke('archive_cross_host_report', { report: JSON.stringify(report), success: false }); },
);
