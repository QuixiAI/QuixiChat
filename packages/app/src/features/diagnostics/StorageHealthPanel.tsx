import { useEffect, useRef, useSyncExternalStore } from 'react';
import { BLOB_INVENTORY_KINDS } from '@quixi/core/contracts';
import type { BlobInventoryFindingKind, BlobInventoryStatus } from '@quixi/core/contracts';
import type { StorageHealthController } from './controller.ts';
import './diagnostics.css';

const descriptions: Record<BlobInventoryFindingKind, { title: string; guidance: string }> = {
  missing_blob: { title: 'Referenced file missing', guidance: 'A saved record needs a file that is absent. Keep the archive and check an earlier backup for the original.' },
  missing_catalog: { title: 'File metadata missing', guidance: 'A saved record refers to a file without its storage metadata. Keep the archive and compare it with a verified backup.' },
  orphan_blob: { title: 'Unreferenced stored file', guidance: 'No current reference was found. Interrupted work can leave files behind; this finding alone does not establish that deletion is safe.' },
  size_mismatch: { title: 'File size differs', guidance: 'The stored file size differs from its recorded size. Preserve the file and check a backup before using it.' },
  protected_blob: { title: 'File retained for transfer or import', guidance: 'Saved transfer or import data still refers to this file. Preserve it until that work has been resolved.' },
  staged_file: { title: 'Temporary staged file', guidance: 'Work in progress can leave temporary files here. Let active work finish, then scan again.' },
  unrecognized_entry: { title: 'Unrecognized storage entry', guidance: 'This entry does not match a managed file path. Leave it in place while investigating the storage issue.' },
};
const phases: Record<BlobInventoryStatus['phase'], string> = { preparing: 'Preparing the scan', references: 'Checking saved references', transfers: 'Checking transfers', catalog: 'Checking file metadata', files: 'Checking stored files', finished: 'Scan finished' };
export function StorageHealthPanel({ controller, disabled = false }: { controller: StorageHealthController; disabled?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), status = state.status;
  const start = useRef<HTMLButtonElement>(null), stop = useRef<HTMLButtonElement>(null), results = useRef<HTMLHeadingElement>(null);
  const running = status?.state === 'running', complete = status?.state === 'complete';
  useEffect(() => { void controller.refresh(); }, [controller]);
  useEffect(() => { if (running && document.activeElement === start.current) stop.current?.focus(); }, [running]);
  const page = async (first: boolean) => { await controller.page(first); results.current?.focus(); };
  return <section className="storage-health" aria-label="Storage health">
    <h1>Storage health</h1>
    <p>Check whether saved records and stored files agree. The scan checks references, file presence and sizes; it does not verify the contents of every file.</p>
    <p>This runs on your device and leaves files and saved history unchanged. Findings show managed storage identifiers, never message content or original filenames.</p>
    <div className="storage-health-actions">
      <button ref={start} disabled={disabled || running || state.loading} onClick={() => void controller.start()}>{status || state.error ? 'Start a new scan' : 'Start storage scan'}</button>
      {running && <button ref={stop} disabled={state.loading} onClick={() => void controller.stop()}>Stop scan</button>}
    </div>
    {disabled && <p role="status">The selected archive changed. Open the selected archive before starting a scan.</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {status?.state === 'stale' && !state.error && <p role="status">Storage changed. These findings are out of date. Start a new scan.</p>}
    {status?.state === 'failed' && !state.error && <p role="alert">The scan could not finish. Start a new scan; if it fails again, reopen the app.</p>}
    {status?.state === 'cancelled' && <p role="status">Scan stopped. No files or saved records were changed. Start a new scan when you are ready.</p>}
    {(running || complete) && status && <>
      <p role="status" aria-live="polite">{complete ? 'Scan complete.' : `${phases[status.phase]}…`} {state.loading && 'Loading findings…'}</p>
      <dl className="storage-health-progress" aria-label="Scan progress">
        <div><dt>Saved records checked</dt><dd>{status.scannedRecords.toLocaleString()}</dd></div>
        <div><dt>Transfers checked</dt><dd>{status.scannedTransfers.toLocaleString()}</dd></div>
        <div><dt>Metadata entries checked</dt><dd>{status.scannedCatalogEntries.toLocaleString()}</dd></div>
        <div><dt>Storage entries checked</dt><dd>{status.scannedFiles.toLocaleString()}</dd></div>
      </dl>
      {complete && <>
        <h2>Finding counts</h2>
        <dl className="storage-health-counts">{BLOB_INVENTORY_KINDS.map(kind => <div key={kind}><dt>{descriptions[kind].title}</dt><dd>{status.counts[kind].toLocaleString()}</dd></div>)}</dl>
        {BLOB_INVENTORY_KINDS.every(kind => status.counts[kind] === 0) && <p>No findings in this scan. This is not a full content-integrity check.</p>}
        <h2 ref={results} tabIndex={-1}>Storage findings</h2>
        <p>Showing one page at a time, up to 32 findings. A new scan is needed after storage changes.</p>
        <ol className="storage-health-findings" aria-label="Storage findings" start={state.findings[0]?.sequence ?? 1} aria-busy={state.loading}>
          {state.findings.map(finding => <li key={finding.sequence}>
            <h3>{descriptions[finding.kind].title}</h3><p>{descriptions[finding.kind].guidance}</p>
            <dl>
              {finding.sha256 && <><dt>File digest</dt><dd><code>{finding.sha256}</code></dd></>}
              {finding.path && <><dt>Managed path</dt><dd><code>{finding.path}</code></dd></>}
              <dt>Saved references</dt><dd>{finding.references.toLocaleString()}</dd>
              {finding.expectedBytes !== null && <><dt>Recorded bytes</dt><dd>{finding.expectedBytes.toLocaleString()}</dd></>}
              {finding.actualBytes !== null && <><dt>Stored bytes</dt><dd>{finding.actualBytes.toLocaleString()}</dd></>}
            </dl>
          </li>)}
        </ol>
        <div className="storage-health-actions" aria-label="Finding pages">
          <button disabled={state.loading || !state.findings.length || state.findings[0]!.sequence <= 1} onClick={() => void page(true)}>First findings</button>
          <button disabled={state.loading || !state.nextCursor} onClick={() => void page(false)}>Next findings</button>
        </div>
      </>}
    </>}
  </section>;
}
