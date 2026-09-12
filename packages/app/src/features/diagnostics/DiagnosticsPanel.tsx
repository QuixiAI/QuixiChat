import { useSyncExternalStore } from 'react';
import type { DiagnosticCheckId, DiagnosticOutcome } from '@quixi/core/contracts';
import type { InferenceCheckId } from '@quixi/quixi-embed/service';
import type { DiagnosticsController } from './report-controller.ts';
import type { SemanticController, SemanticSnapshot } from '../semantic/controller.ts';
import './diagnostics.css';

/** Product §100 check names, in the product's order. */
const checkLabels: Record<DiagnosticCheckId, string> = {
  sqlite_integrity: 'SQLite integrity', schema: 'Schema', persistence: 'OPFS persistence', fts5: 'FTS5', sqlite_vec: 'sqlite-vec',
  attachment_references: 'Attachment references', ownership: 'Storage ownership', lexical_index: 'Search index (FTS)', semantic_index: 'Semantic index',
};
/** The four states plan 23 requires to be told apart, plus attention and unknown. */
const outcomeLabels: Record<DiagnosticOutcome, { mark: string; label: string }> = {
  ok: { mark: '✓', label: 'OK' },
  corruption: { mark: '✗', label: 'Corruption detected' },
  unsupported: { mark: '–', label: 'Not supported on this host' },
  missing_data: { mark: '⚠', label: 'Missing data' },
  rebuildable: { mark: '↻', label: 'Rebuildable derived index' },
  attention: { mark: '⚠', label: 'Needs attention' },
  unknown: { mark: '?', label: 'Not reported' },
};
/** Product §100 inference check names, in the product's order. */
const inferenceLabels: Record<InferenceCheckId, string> = { model_hash: 'Model hash', tokenizer: 'Tokenizer', scalar_golden: 'Scalar golden', wasm_simd_backend: 'WASM SIMD backend', webgpu_backend: 'WebGPU backend' };
const sizes = (bytes: number) => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(0)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
export function DiagnosticsPanel({ controller, semantic, semanticState, disabled = false }: { controller: DiagnosticsController; semantic: SemanticController; semanticState: SemanticSnapshot; disabled?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), report = state.report;
  const busy = disabled || state.running;
  const hostless = semanticState.runtime === 'no-host-assets';
  const semanticAction = (action: 'delete' | 'rebuild') => controller.trackSemanticAction(async () => {
    if (action === 'delete') await semantic.deleteIndex(); else await semantic.rebuild();
    const failure = semantic.getSnapshot().error;
    if (failure) return `${action === 'delete' ? 'Semantic index deletion' : 'Semantic index rebuild'} did not complete: ${failure}`;
    return action === 'delete'
      ? 'Semantic index deleted. Stored vectors and the enrolment are gone; saved history and the search index are unchanged.'
      : 'Semantic index rebuild started: vectors were dropped and a new generation is enrolled; embedding resumes in the background.';
  });
  return <section className="diagnostics" aria-label="Diagnostics">
    <h2>Diagnostics</h2>
    <p>Check SQLite, the schema, persistence, search capabilities, attachment references and the derived indexes. The report holds counts, versions and states, never message text, filenames or secrets.</p>
    <div className="storage-health-actions">
      <button disabled={busy} onClick={() => void controller.run()}>{report ? 'Run diagnostics again' : 'Run diagnostics'}</button>
    </div>
    {state.running && <p role="status">Running diagnostics…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {report && <>
      <dl className="diagnostic-checks" aria-label="Diagnostic checks" data-testid="diagnostic-checks">
        {report.checks.map(check => <div key={check.id} data-testid={`diagnostic-${check.id}`} data-outcome={check.outcome}>
          <dt>{checkLabels[check.id]}</dt>
          <dd><span className={`diagnostic-outcome diagnostic-${check.outcome}`}>{outcomeLabels[check.outcome].mark} {outcomeLabels[check.outcome].label}</span><br /><span className="muted">{check.summary}</span></dd>
        </div>)}
      </dl>
      <p className="muted" data-testid="diagnostic-report-meta">SQLite {report.sqliteVersion} · schema {report.schemaVersion} · {report.checks.find(check => check.id === 'persistence')?.measured.usage === null ? 'usage not reported' : `${sizes(Number(report.checks.find(check => check.id === 'persistence')?.measured.usage))} used`} · report produced {new Date(report.producedAt).toLocaleTimeString()}</p>
    </>}
    <h3>Save report</h3>
    <p>Saves the storage report and the inference self-test above as one JSON file: counts, versions, states and managed identifiers only. It never contains provider credentials or conversation text.</p>
    <div className="storage-health-actions">
      <button disabled={busy || !report} onClick={() => void controller.save(semanticState.selfTest, { inferenceOmitted: hostless ? 'This host does not provide the local embedding model.' : semanticState.selfTest ? null : 'The inference self-test was not run.' })}>Save diagnostics report</button>
    </div>
    {!report && <p className="muted">Run diagnostics first; the file is built from the report shown here.</p>}
    <h3>Repair actions</h3>
    <p>These recreate derived data only. Saved conversations, import provenance, branches and attachment bytes are never changed by them.</p>
    <div className="storage-health-actions" aria-label="Repair actions">
      <button disabled={busy} onClick={() => void controller.rebuildSearchIndex()}>Rebuild search index</button>
      <button disabled={busy} onClick={() => void semanticAction('delete')}>Delete semantic index</button>
      <button disabled={busy || hostless} onClick={() => void semanticAction('rebuild')}>Rebuild semantic index</button>
    </div>
    {hostless && <p className="muted">Rebuilding the semantic index needs the local embedding model, which this host does not provide.</p>}
    {state.notice && <p role="status" data-testid="diagnostic-notice">{state.notice}</p>}
    <h3>Inference</h3>
    <p>Re-verifies the local embedding model against its pinned hash and runs three frozen reference cases through the tokenizer and every backend available here. Loads the model if it is not loaded; nothing is indexed or sent anywhere.</p>
    <div className="storage-health-actions">
      <button disabled={disabled || semanticState.busy || hostless} onClick={() => void semantic.selfTest()}>{semanticState.selfTest ? 'Run inference self-test again' : 'Run inference self-test'}</button>
    </div>
    {hostless && <p className="muted">This host does not provide the local embedding model, so there is nothing to test.</p>}
    {semanticState.busy && !semanticState.selfTest && !hostless && <p role="status">{semanticState.runtime === 'loading' ? 'Loading the local model…' : 'Running the self-test…'}</p>}
    {semanticState.error && <p role="alert">{semanticState.error}</p>}
    {semanticState.selfTest && <>
      <dl className="diagnostic-checks" aria-label="Inference checks" data-testid="inference-checks">
        {semanticState.selfTest.checks.map(check => <div key={check.id} data-testid={`inference-${check.id}`} data-outcome={check.outcome}>
          <dt>{inferenceLabels[check.id]}</dt>
          <dd><span className={`diagnostic-outcome diagnostic-${check.outcome}`}>{outcomeLabels[check.outcome].mark} {outcomeLabels[check.outcome].label}</span><br /><span className="muted">{check.summary}</span></dd>
        </div>)}
      </dl>
      <p className="muted" data-testid="inference-report-meta">Serving route {semanticState.selfTest.route} · {semanticState.selfTest.cases.length} reference cases from golden manifest {semanticState.selfTest.goldenManifestSha256.slice(0, 12)}… · {(semanticState.selfTest.elapsedMs / 1000).toFixed(1)} s</p>
    </>}
  </section>;
}
