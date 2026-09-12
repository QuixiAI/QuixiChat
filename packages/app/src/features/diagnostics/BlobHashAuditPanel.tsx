import { useEffect, useRef, useSyncExternalStore } from 'react';
import { BLOB_HASH_AUDIT_KINDS } from '@quixi/core/contracts';
import type { BlobHashAuditFindingKind } from '@quixi/core/contracts';
import type { BlobHashAuditController } from './controller.ts';
import './diagnostics.css';

/** Product §101 "verify blob hashes". */
const descriptions: Record<BlobHashAuditFindingKind, { title: string; guidance: string }> = {
  hash_mismatch: { title: 'File content differs from its digest', guidance: 'The stored bytes are not the bytes that were saved. Quixi will not serve this file as verified. Restore it from an earlier backup.' },
  size_mismatch: { title: 'File size differs from its record', guidance: 'The stored file is a different length than its catalog entry. Preserve it and compare with a backup.' },
  missing_blob: { title: 'Catalogued file missing', guidance: 'The catalog names a file that is absent. The storage scan lists which saved records need it.' },
  read_error: { title: 'File could not be read', guidance: 'The file exists but could not be opened or read to the end. Try again; if it repeats, the browser storage may be damaged.' },
};
const sizes = (bytes: number) => bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(0)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
export function BlobHashAuditPanel({ controller, disabled = false }: { controller: BlobHashAuditController; disabled?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), status = state.status;
  const start = useRef<HTMLButtonElement>(null), stop = useRef<HTMLButtonElement>(null), results = useRef<HTMLHeadingElement>(null);
  const running = status?.state === 'running', complete = status?.state === 'complete';
  useEffect(() => { void controller.refresh(); }, [controller]);
  useEffect(() => { if (running && document.activeElement === start.current) stop.current?.focus(); }, [running]);
  const page = async (first: boolean) => { await controller.page(first); results.current?.focus(); };
  return <section className="storage-health blob-hash-audit" aria-label="File content verification">
    <h2>File content verification</h2>
    <p>Re-reads every catalogued attachment, raw source and text file through the same verified path that serves them and compares the bytes with the digest recorded when they were saved.</p>
    <p>This reads files in small blocks so it can be stopped at any time. It changes nothing. Findings show digests and sizes, never original filenames or content.</p>
    <div className="storage-health-actions">
      <button ref={start} disabled={disabled || running || state.loading} onClick={() => void controller.start()}>{status || state.error ? 'Verify again' : 'Verify file contents'}</button>
      {running && <button ref={stop} disabled={state.loading} onClick={() => void controller.stop()}>Stop verification</button>}
    </div>
    {disabled && <p role="status">The selected archive changed. Open the selected archive before verifying.</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {status?.state === 'stale' && !state.error && <p role="status">Stored files changed. These findings are out of date. Verify again.</p>}
    {status?.state === 'failed' && !state.error && <p role="alert">The verification could not finish. Verify again; if it fails again, reopen the app.</p>}
    {status?.state === 'cancelled' && <p role="status">Verification stopped. Nothing was changed. Verify again when you are ready.</p>}
    {(running || complete) && status && <>
      <p role="status" aria-live="polite" data-testid="hash-audit-status">{complete ? 'Verification complete.' : 'Verifying file contents…'} {state.loading && 'Loading findings…'}</p>
      <dl className="storage-health-progress" aria-label="Verification progress">
        <div><dt>Files checked</dt><dd data-testid="hash-audit-files">{status.scannedFiles.toLocaleString()} of {status.totalFiles.toLocaleString()}</dd></div>
        <div><dt>Bytes verified</dt><dd data-testid="hash-audit-bytes">{sizes(status.verifiedBytes)} of {sizes(status.totalBytes)}</dd></div>
      </dl>
      {complete && <>
        <h3>Finding counts</h3>
        <dl className="storage-health-counts" data-testid="hash-audit-counts">{BLOB_HASH_AUDIT_KINDS.filter(kind => status.counts[kind] > 0).map(kind => <div key={kind} data-kind={kind}><dt>{descriptions[kind].title}</dt><dd>{status.counts[kind].toLocaleString()}</dd></div>)}</dl>
        {BLOB_HASH_AUDIT_KINDS.every(kind => status.counts[kind] === 0) && <p data-testid="hash-audit-clean">Every catalogued file matches its digest.</p>}
        {BLOB_HASH_AUDIT_KINDS.some(kind => status.counts[kind] > 0) && <>
          <h3 ref={results} tabIndex={-1}>Verification findings</h3>
          <p>Showing one page at a time, up to 32 findings. No file is changed or removed here.</p>
          <ol className="storage-health-findings" aria-label="Verification findings" start={state.findings[0]?.sequence ?? 1} aria-busy={state.loading}>
            {state.findings.map(finding => <li key={finding.sequence}>
              <h4>{descriptions[finding.kind].title}</h4><p>{descriptions[finding.kind].guidance}</p>
              <dl>
                <dt>File digest</dt><dd><code>{finding.sha256}</code></dd>
                <dt>Managed path</dt><dd><code>{finding.path}</code></dd>
                <dt>Recorded bytes</dt><dd>{finding.expectedBytes.toLocaleString()}</dd>
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
    </>}
  </section>;
}
