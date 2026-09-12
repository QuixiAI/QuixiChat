import { useEffect, useRef, useSyncExternalStore } from 'react';
import { BLOB_INVENTORY_KINDS } from '@quixi/core/contracts';
import type { BlobInventoryFindingKind, BlobInventoryStatus } from '@quixi/core/contracts';
import type { StorageHealthController } from './controller.ts';
import type { CleanupController } from './cleanup-controller.ts';
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
const sizes = (bytes: number) => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const refusals: Record<string, string> = { not_a_finding: 'not an unreferenced file of this scan', referenced: 'a saved record refers to it', protected: 'a transfer or import still holds it', in_use: 'it is open for reading', missing: 'it was already gone', stale: 'the scan was no longer current' };
export function StorageHealthPanel({ controller, cleanup, disabled = false }: { controller: StorageHealthController; cleanup: CleanupController; disabled?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), status = state.status;
  const selection = useSyncExternalStore(cleanup.subscribe, cleanup.getSnapshot);
  const selectedCount = Object.keys(selection.selected).length, selectedBytes = Object.values(selection.selected).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const start = useRef<HTMLButtonElement>(null), stop = useRef<HTMLButtonElement>(null), results = useRef<HTMLHeadingElement>(null);
  const running = status?.state === 'running', complete = status?.state === 'complete';
  useEffect(() => { void controller.refresh(); }, [controller]);
  useEffect(() => { if (running && document.activeElement === start.current) stop.current?.focus(); }, [running]);
  const page = async (first: boolean) => { await controller.page(first); results.current?.focus(); };
  return <section className="storage-health" aria-label="Storage health">
    <h1>Storage health</h1>
    <p>Check whether saved records and stored files agree. The scan checks references, file presence and sizes; it does not verify the contents of every file.</p>
    <p>This runs on your device and leaves files and saved history unchanged. Findings show managed storage identifiers, never message content or original filenames. The only deletion offered is of unreferenced stored files you tick and review below.</p>
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
            {finding.kind === 'orphan_blob' && finding.sha256 && <label className="storage-health-select"><input type="checkbox" checked={finding.sha256 in selection.selected} disabled={selection.busy || selection.reviewing} onChange={() => cleanup.toggle(finding)} /> Select this unreferenced file for deletion</label>}
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
        <section aria-label="Reviewed cleanup" className="storage-health-cleanup" data-testid="storage-cleanup">
          <h2>Reviewed cleanup</h2>
          <p data-testid="cleanup-scope">{selectedCount === 0 ? 'No files selected. Tick unreferenced stored files above to review deleting them; up to 32 per cleanup.' : `${selectedCount} unreferenced file${selectedCount === 1 ? '' : 's'} selected, ${sizes(selectedBytes)} in total.`}</p>
          {!selection.reviewing && <div className="storage-health-actions"><button disabled={selection.busy || selectedCount === 0 || status.state !== 'complete'} onClick={() => cleanup.review()}>Review deletion…</button></div>}
          {selection.reviewing && <div role="group" aria-labelledby="cleanup-review-title" className="storage-health-review" data-testid="cleanup-review">
            <h3 id="cleanup-review-title">Delete {selectedCount} unreferenced file{selectedCount === 1 ? '' : 's'} ({sizes(selectedBytes)})?</h3>
            <p>These files have no saved reference in this scan. Deletion is permanent and cannot be undone. Saved conversations, attachments in use and import data are not touched; every file is re-checked before removal and refused if anything holds it.</p>
            <ul className="storage-health-scope">{Object.entries(selection.selected).map(([sha256, bytes]) => <li key={sha256}><code>{sha256}</code>{bytes !== null && ` · ${bytes.toLocaleString()} bytes`}</li>)}</ul>
            <div className="storage-health-actions">
              <button className="danger" disabled={selection.busy} onClick={() => void cleanup.confirm()}>{selection.busy ? 'Deleting…' : `Delete ${selectedCount} file${selectedCount === 1 ? '' : 's'}`}</button>
              <button disabled={selection.busy} onClick={() => cleanup.cancelReview()}>Keep the files</button>
            </div>
          </div>}
        </section>
      </>}
    </>}
    {selection.error && <p role="alert">{selection.error}</p>}
    {selection.result && <div role="status" data-testid="cleanup-result">
      <p>{selection.result.deleted.length === 0 ? 'No file was deleted.' : `Deleted ${selection.result.deleted.length} unreferenced file${selection.result.deleted.length === 1 ? '' : 's'} (${sizes(selection.result.deleted.reduce((sum, item) => sum + (item.byteLength ?? 0), 0))}).`}{selection.result.refused.length > 0 && ` ${selection.result.refused.length} refused.`} Start a new scan to see current findings.</p>
      {selection.result.refused.length > 0 && <ul className="storage-health-scope">{selection.result.refused.map(item => <li key={item.sha256}><code>{item.sha256}</code> · kept: {refusals[item.reason] ?? item.reason}</li>)}</ul>}
    </div>}
  </section>;
}
