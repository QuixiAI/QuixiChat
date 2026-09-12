import { useEffect, useRef, useSyncExternalStore } from 'react';
import { DOCTOR_AUDIT_KINDS } from '@quixi/core/contracts';
import type { DoctorAuditFindingKind, DoctorAuditStatus } from '@quixi/core/contracts';
import type { DoctorAuditController } from './controller.ts';
import './diagnostics.css';

/** Product §101: validate branches, validate import provenance, validate sync coverage. */
const descriptions: Record<DoctorAuditFindingKind, { title: string; guidance: string }> = {
  missing_parent: { title: 'Message parent missing', guidance: 'A message names a parent that is not in the archive. The message stays readable; its branch cannot be walked from the root.' },
  cross_thread_parent: { title: 'Parent in another conversation', guidance: 'A message names a parent from a different conversation. Keep both; compare with a backup before any repair.' },
  self_reference: { title: 'Message refers to itself', guidance: 'A message names itself as its parent or edit origin. Branch walks stop at it.' },
  part_count_mismatch: { title: 'Part count differs', guidance: 'A message declares a different number of content parts than are stored, or their order has gaps. Some content may not render.' },
  generation_link_mismatch: { title: 'Generation link broken', guidance: 'An assistant message names a generation that is missing or that names another output.' },
  edited_from_missing: { title: 'Edit origin missing', guidance: 'An edited message names an original that is not in the archive.' },
  dangling_active_leaf: { title: 'Selected branch missing', guidance: 'A conversation selects a leaf message that is not in it. Selecting another branch repairs the selection.' },
  missing_context: { title: 'Context snapshot missing', guidance: 'A conversation state names a context snapshot that is not in the archive.' },
  thread_without_state: { title: 'Conversation without state', guidance: 'A conversation has no title, tags or selection record.' },
  context_chain_break: { title: 'Context chain broken', guidance: 'A context snapshot does not follow its predecessor by one version.' },
  missing_import_source: { title: 'Import source missing', guidance: 'A record names an import source that is not in the archive; provenance cannot be shown for it.' },
  missing_provenance_entity: { title: 'Provenance target missing', guidance: 'A provenance record names an entity that is not in the archive.' },
  missing_raw_object: { title: 'Raw source missing', guidance: 'A provenance record names a raw provider object that is not in the archive.' },
  dangling_source_identity: { title: 'Source identity target missing', guidance: 'A provider identity mapping names a record that is not in the archive; re-importing that source may create a duplicate.' },
  sync_affects_missing: { title: 'Sync operation names a missing record', guidance: 'A recorded operation affected a record that is not in the archive. History before that operation may be incomplete.' },
  sync_affects_malformed: { title: 'Sync operation record malformed', guidance: 'A recorded operation does not list its affected records in the expected form.' },
};
const phases: Record<DoctorAuditStatus['phase'], string> = { preparing: 'Preparing the audit', branches: 'Validating branches', provenance: 'Validating import provenance', sync: 'Validating sync coverage', finished: 'Audit finished' };
export function DoctorAuditPanel({ controller, disabled = false }: { controller: DoctorAuditController; disabled?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), status = state.status;
  const start = useRef<HTMLButtonElement>(null), stop = useRef<HTMLButtonElement>(null), results = useRef<HTMLHeadingElement>(null);
  const running = status?.state === 'running', complete = status?.state === 'complete';
  useEffect(() => { void controller.refresh(); }, [controller]);
  useEffect(() => { if (running && document.activeElement === start.current) stop.current?.focus(); }, [running]);
  const page = async (first: boolean) => { await controller.page(first); results.current?.focus(); };
  return <section className="storage-health doctor-audit" aria-label="Doctor audit">
    <h2>Doctor audit</h2>
    <p>Validate branches, import provenance and sync coverage: every message's parent, parts and generation link, every conversation's selection and context chain, every provenance record's source and target, and every recorded operation's affected records.</p>
    <p>This runs on your device in bounded steps and changes nothing. Findings show record identifiers and counts, never message content or titles.</p>
    <div className="storage-health-actions">
      <button ref={start} disabled={disabled || running || state.loading} onClick={() => void controller.start()}>{status || state.error ? 'Start a new audit' : 'Start Doctor audit'}</button>
      {running && <button ref={stop} disabled={state.loading} onClick={() => void controller.stop()}>Stop audit</button>}
    </div>
    {disabled && <p role="status">The selected archive changed. Open the selected archive before starting an audit.</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {status?.state === 'stale' && !state.error && <p role="status">Saved history changed. These findings are out of date. Start a new audit.</p>}
    {status?.state === 'failed' && !state.error && <p role="alert">The audit could not finish. Start a new audit; if it fails again, reopen the app.</p>}
    {status?.state === 'cancelled' && <p role="status">Audit stopped. Nothing was changed. Start a new audit when you are ready.</p>}
    {(running || complete) && status && <>
      <p role="status" aria-live="polite" data-testid="doctor-audit-status">{complete ? 'Audit complete.' : `${phases[status.phase]}…`} {state.loading && 'Loading findings…'}</p>
      <dl className="storage-health-progress" aria-label="Audit progress">
        <div><dt>Saved records checked</dt><dd data-testid="doctor-audit-records">{status.scannedRecords.toLocaleString()}</dd></div>
        <div><dt>Recorded operations checked</dt><dd data-testid="doctor-audit-operations">{status.scannedOperations.toLocaleString()}</dd></div>
      </dl>
      {complete && <>
        <h3>Finding counts</h3>
        <dl className="storage-health-counts" data-testid="doctor-audit-counts">{DOCTOR_AUDIT_KINDS.filter(kind => status.counts[kind] > 0).map(kind => <div key={kind} data-kind={kind}><dt>{descriptions[kind].title}</dt><dd>{status.counts[kind].toLocaleString()}</dd></div>)}</dl>
        {DOCTOR_AUDIT_KINDS.every(kind => status.counts[kind] === 0) && <p data-testid="doctor-audit-clean">No findings. Branches, provenance and sync coverage agree with the saved records.</p>}
        {DOCTOR_AUDIT_KINDS.some(kind => status.counts[kind] > 0) && <>
          <h3 ref={results} tabIndex={-1}>Audit findings</h3>
          <p>Showing one page at a time, up to 32 findings. No repair is offered here: canonical history is never rewritten by Quixi. Export a backup and compare with an earlier one.</p>
          <ol className="storage-health-findings" aria-label="Audit findings" start={state.findings[0]?.sequence ?? 1} aria-busy={state.loading}>
            {state.findings.map(finding => <li key={finding.sequence}>
              <h4>{descriptions[finding.kind].title}</h4><p>{descriptions[finding.kind].guidance}</p>
              <dl>
                <dt>Record</dt><dd><code>{finding.collection}/{finding.id}</code></dd>
                {finding.relatedId && <><dt>Names</dt><dd><code>{finding.relatedCollection}/{finding.relatedId}</code></dd></>}
                {finding.expected !== null && <><dt>Declared</dt><dd>{finding.expected.toLocaleString()}</dd></>}
                {finding.actual !== null && <><dt>Found</dt><dd>{finding.actual.toLocaleString()}</dd></>}
              </dl>
            </li>)}
          </ol>
          <div className="storage-health-actions" aria-label="Finding pages">
            <button disabled={state.loading || !state.findings.length || state.findings[0]!.sequence <= 1} onClick={() => void page(true)}>First findings</button>
            <button disabled={state.loading || !state.nextCursor} onClick={() => void page(false)}>Next findings</button>
          </div>
        </>}
      </>}
    </>}
  </section>;
}
