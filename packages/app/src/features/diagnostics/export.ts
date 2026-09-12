import type { DiagnosticsReport, HostClient } from '@quixi/core/contracts';
import { assertDiagnosticsReportContent } from '@quixi/core/contracts';
import type { InferenceSelfTest } from '@quixi/quixi-embed/service';

/** Product §100/§101 exportable diagnostics (plan 23). The file is built from
 * an explicit allow-list of fields, so nothing reaches it that the two
 * reports do not already classify as operational metadata: no credentials
 * (the app never holds them; secrets live behind the host boundary), no
 * message text, filenames or provider payloads. */
export interface DiagnosticsExport {
  format: 'quixi-diagnostics';
  version: 1;
  producedAt: number;
  contentPolicy: 'operational-metadata-only';
  host: { kind: 'web' | 'desktop'; userAgent: string | null };
  storage: DiagnosticsReport | null;
  inference: InferenceSelfTest | null;
  /** Why a section is absent, in plain words. */
  omitted: { storage: string | null; inference: string | null };
}
const measure = (value: unknown) => typeof value === 'string' ? value.slice(0, 256) : typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
const measured = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, measure(entry)]));
function storageSection(report: DiagnosticsReport): DiagnosticsReport {
  const section: DiagnosticsReport = {
    version: 1, producedAt: report.producedAt, backend: report.backend, sqliteVersion: report.sqliteVersion, schemaVersion: report.schemaVersion, ownerId: report.ownerId,
    bounds: { referenceRecords: report.bounds.referenceRecords, referenceFiles: report.bounds.referenceFiles },
    checks: report.checks.map(check => ({ id: check.id, outcome: check.outcome, summary: check.summary, measured: measured(check.measured) as DiagnosticsReport['checks'][number]['measured'] })),
    contentPolicy: 'operational-metadata-only',
  };
  assertDiagnosticsReportContent(section);
  return section;
}
function inferenceSection(result: InferenceSelfTest): InferenceSelfTest {
  return {
    version: 1, producedAt: result.producedAt, route: result.route, kind: result.kind, goldenManifestSha256: result.goldenManifestSha256, cases: result.cases.map(String), thresholds: result.thresholds, elapsedMs: result.elapsedMs,
    checks: result.checks.map(check => ({ id: check.id, outcome: check.outcome, summary: check.summary, measured: measured(check.measured) as InferenceSelfTest['checks'][number]['measured'] })),
  };
}
export function buildDiagnosticsExport(input: { storage: DiagnosticsReport | null; inference: InferenceSelfTest | null; host: 'web' | 'desktop'; userAgent?: string | null; inferenceOmitted?: string | null; now?: number }): DiagnosticsExport {
  return {
    format: 'quixi-diagnostics', version: 1, producedAt: input.now ?? Date.now(), contentPolicy: 'operational-metadata-only',
    host: { kind: input.host, userAgent: input.userAgent ? input.userAgent.slice(0, 256) : null },
    storage: input.storage ? storageSection(input.storage) : null,
    inference: input.inference ? inferenceSection(input.inference) : null,
    omitted: { storage: input.storage ? null : 'Run diagnostics before saving to include the storage report.', inference: input.inference ? null : (input.inferenceOmitted ?? 'The inference self-test was not run.') },
  };
}
export const diagnosticsExportName = (producedAt: number) => `quixi-diagnostics-${new Date(producedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
export function serializeDiagnosticsExport(report: DiagnosticsExport): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(report, null, 2) + '\n');
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Stages the bytes through the host's verified file_save transfer and opens its save flow. */
export async function saveDiagnosticsExport(host: HostClient, report: DiagnosticsExport): Promise<{ name: string; byteLength: number; sha256: string }> {
  const id = () => crypto.randomUUID();
  const bytes = serializeDiagnosticsExport(report), sha256 = await sha256Hex(bytes), name = diagnosticsExportName(report.producedAt);
  const transfer = await host.beginTransfer(id(), { purpose: 'file_save', expectedBytes: bytes.byteLength, expectedSha256: sha256 });
  try {
    if (!Number.isSafeInteger(transfer.maxChunkBytes) || transfer.maxChunkBytes < 1) throw new Error('Host declared an invalid transfer bound.');
    let offset = 0, sequence = 0;
    while (offset < bytes.byteLength) {
      const piece = bytes.subarray(offset, offset + transfer.maxChunkBytes);
      await host.writeChunk({ transferId: transfer.transferId, sequence: sequence++, offset, bytes: piece, final: false });
      offset += piece.byteLength;
    }
    await host.writeChunk({ transferId: transfer.transferId, sequence, offset, bytes: new Uint8Array(), final: true });
    await host.finishTransfer(id(), transfer.transferId, { byteLength: bytes.byteLength, sha256 });
    await host.saveFileTransfer(id(), { name, mediaType: 'application/json', transferId: transfer.transferId });
    return { name, byteLength: bytes.byteLength, sha256 };
  } finally { await host.releaseTransfer(id(), transfer.transferId).catch(() => {}); }
}
