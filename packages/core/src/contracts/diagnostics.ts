/** Product §100/§101: the storage diagnostics report. Every check names one
 * of a fixed set of outcomes so detected corruption is never confused with
 * an unsupported capability, missing data or a rebuildable derived index.
 * The report carries operational metadata only: counts, versions, states
 * and managed identifiers, never conversation text, filenames or secrets. */
export const DIAGNOSTIC_CHECKS = [
  'sqlite_integrity', 'schema', 'persistence', 'fts5', 'sqlite_vec',
  'attachment_references', 'ownership', 'lexical_index', 'semantic_index',
] as const;
export type DiagnosticCheckId = typeof DIAGNOSTIC_CHECKS[number];
export const DIAGNOSTIC_OUTCOMES = ['ok', 'corruption', 'unsupported', 'missing_data', 'rebuildable', 'attention', 'unknown'] as const;
/** ok: verified healthy. corruption: SQLite or the canonical schema is
 * damaged; keep the bytes and use export/rescue paths. unsupported: this host
 * lacks the capability; nothing is damaged. missing_data: a saved record
 * refers to bytes this device does not hold. rebuildable: derived search data
 * failed; canonical history is intact and the index can be recreated.
 * attention: usable but worth acting on (for example persistence not
 * granted). unknown: the host did not report it. */
export type DiagnosticOutcome = typeof DIAGNOSTIC_OUTCOMES[number];
export type DiagnosticMeasure = string | number | boolean | null;
export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  outcome: DiagnosticOutcome;
  /** One plain sentence with no record content. */
  summary: string;
  measured: Record<string, DiagnosticMeasure>;
}
export interface DiagnosticsReport {
  version: 1;
  producedAt: number;
  backend: 'sqlite-wasm-opfs-sahpool';
  sqliteVersion: string;
  schemaVersion: number;
  ownerId: string;
  /** How far the bounded reference check looked. */
  bounds: { referenceRecords: number; referenceFiles: number };
  checks: DiagnosticCheck[];
  contentPolicy: 'operational-metadata-only';
}
export interface DiagnosticsOperations {
  /** Read-only. Runs integrity_check, so it is an explicit action rather than a poll. */
  diagnosticsReport: { args: null; result: DiagnosticsReport };
}
/** The explicit report's `integrity_check` reads the whole database file, so
 * its reply deadline is the storage client's maximum rather than the default
 * request deadline; the `sqlite_integrity` check records `elapsedMs`. */
export const INTEGRITY_CHECK_DEADLINE_MS = 600_000;
/** The light `diagnostics` operation (read at startup by onboarding and the
 * import controller) verifies integrity only for database files up to this
 * size; larger archives report `unchecked` and are verified on request through
 * the explicit report, so opening a large archive stays bounded. */
export const AUTOMATIC_INTEGRITY_CHECK_MAX_BYTES = 256 * 1024 * 1024;
export function assertDiagnosticsArgs(operation: keyof DiagnosticsOperations, value: unknown): void {
  if (operation === 'diagnosticsReport' && value !== null) throw new Error('Diagnostics report takes null arguments');
}
/** Report content policy: strings in a report may name check ids, outcomes,
 * versions, states and managed identifiers only. */
export function assertDiagnosticsReportContent(report: DiagnosticsReport): void {
  for (const check of report.checks) {
    if (!DIAGNOSTIC_CHECKS.includes(check.id) || !DIAGNOSTIC_OUTCOMES.includes(check.outcome)) throw new Error('Unknown diagnostic check or outcome');
    for (const [key, value] of Object.entries(check.measured))
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || (typeof value === 'string' && value.length > 256)) throw new Error('Diagnostic measurement is not operational metadata');
  }
}
