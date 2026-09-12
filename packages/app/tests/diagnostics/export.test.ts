import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagnosticsReport, HostClient } from '@quixi/core/contracts';
import type { InferenceSelfTest } from '@quixi/quixi-embed/service';
import { buildDiagnosticsExport, diagnosticsExportName, saveDiagnosticsExport, serializeDiagnosticsExport } from '../../src/features/diagnostics/export.ts';

const storage = (): DiagnosticsReport => ({ version: 1, producedAt: 1_700_000_000_000, backend: 'sqlite-wasm-opfs-sahpool', sqliteVersion: '3.53.4', schemaVersion: 12, ownerId: 'owner-1', bounds: { referenceRecords: 4096, referenceFiles: 64 }, contentPolicy: 'operational-metadata-only',
  checks: [{ id: 'attachment_references', outcome: 'missing_data', summary: 'Saved records refer to bytes this device does not hold.', measured: { references: 3, missingFiles: 1, extra: 'x'.repeat(400) } }] });
const inference = (): InferenceSelfTest => ({ version: 1, producedAt: 2, route: 'wasm-simd-fp32', kind: 'cpu', goldenManifestSha256: 'f'.repeat(64), cases: ['edge-queries-2'], thresholds: { cpu: { minCosine: 0.999999, maxAbsolute: 2e-5 }, gpuFp32: { minCosine: 0.9999, maxAbsolute: 1e-3 }, gpuFp16: { minCosine: 0.999, maxAbsolute: 5e-3 } }, elapsedMs: 900,
  checks: [{ id: 'model_hash', outcome: 'ok', summary: 'ok', measured: { sha256: 'e'.repeat(64), source: 'cache', bytes: 90785583 } }] });

test('the export is built from an allow-list: unknown fields are dropped, long strings clipped, sections absent with a stated reason', () => {
  const report = { ...storage(), secretApiKey: 'sk-live-should-not-appear', checks: [{ ...storage().checks[0]!, payload: 'Full conversation text' }] } as unknown as DiagnosticsReport;
  const built = buildDiagnosticsExport({ storage: report, inference: null, host: 'web', userAgent: 'UA', now: 5 });
  const text = new TextDecoder().decode(serializeDiagnosticsExport(built));
  assert.equal(built.format, 'quixi-diagnostics'); assert.equal(built.producedAt, 5); assert.equal(built.host.kind, 'web');
  assert.ok(!text.includes('sk-live')); assert.ok(!text.includes('Full conversation text')); assert.ok(!text.includes('x'.repeat(300)));
  assert.equal(built.storage?.checks[0]?.measured.references, 3);
  assert.equal(built.inference, null); assert.equal(built.omitted.inference, 'The inference self-test was not run.'); assert.equal(built.omitted.storage, null);
  assert.deepEqual(JSON.parse(text), built);
});
test('without a storage report the file still says why, and the inference section carries its checks', () => {
  const built = buildDiagnosticsExport({ storage: null, inference: inference(), host: 'desktop', inferenceOmitted: null });
  assert.equal(built.storage, null); assert.match(built.omitted.storage ?? '', /Run diagnostics before saving/);
  assert.equal(built.inference?.checks[0]?.id, 'model_hash'); assert.equal(built.host.userAgent, null);
  assert.match(diagnosticsExportName(1_700_000_000_000), /^quixi-diagnostics-2023-11-14T22-13-20\.json$/);
});
test('saving stages every byte through the host file_save transfer with the digest, then saves and releases', async () => {
  const written: number[] = [], calls: string[] = [];
  let finished: { byteLength: number; sha256: string } | null = null, saved: { name: string; mediaType: string } | null = null;
  const host = {
    async beginTransfer(_id: string, declaration: { purpose: string; expectedBytes: number | null; expectedSha256: string | null }) { calls.push('begin'); assert.equal(declaration.purpose, 'file_save'); return { transferId: 't', maxChunkBytes: 100, maxInFlight: 1 }; },
    async writeChunk(chunk: { sequence: number; offset: number; bytes: Uint8Array; final: boolean }) { calls.push(chunk.final ? 'final' : 'chunk'); assert.equal(chunk.offset, written.length); written.push(...chunk.bytes); return { transferId: 't', sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length }; },
    async finishTransfer(_id: string, _transfer: string, expected: { byteLength: number; sha256: string }) { calls.push('finish'); finished = expected; return { transferId: 't', ...expected, state: 'verified_staged' }; },
    async saveFileTransfer(_id: string, file: { name: string; mediaType: string }) { calls.push('save'); saved = file; },
    async releaseTransfer() { calls.push('release'); },
  } as unknown as HostClient;
  const built = buildDiagnosticsExport({ storage: storage(), inference: inference(), host: 'web', now: 1_700_000_000_000 });
  const result = await saveDiagnosticsExport(host, built);
  const expected = serializeDiagnosticsExport(built);
  assert.deepEqual(Uint8Array.from(written), expected);
  assert.ok(calls.filter(call => call === 'chunk').length > 1, 'bounded chunks');
  assert.deepEqual(calls.slice(-3), ['finish', 'save', 'release']);
  assert.equal(finished!.byteLength, expected.byteLength); assert.equal(result.sha256, finished!.sha256); assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(saved!.mediaType, 'application/json'); assert.equal(saved!.name, result.name);
});
