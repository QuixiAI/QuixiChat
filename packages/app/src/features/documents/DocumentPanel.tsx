import { useEffect, useState, useSyncExternalStore } from 'react';
import type { createDocumentController } from './controller.ts';
import type { ClearPdfExtractionTarget } from '@quixi/documents/storage';
import './documents.css';

type Controller = ReturnType<typeof createDocumentController>;

function interruptionMessage(failure: string | null): string {
  switch (failure) {
    case 'password_required': return 'This PDF requires a password. Password entry is not supported yet. Import an unlocked copy to extract its text.';
    case 'parser_failed': return 'Text extraction could not read this PDF. You can retry or import a repaired copy. The original file is unchanged.';
    case 'capacity': return 'Text extraction reached a document or storage limit. Try a smaller PDF, or free storage if your archive is full. Saved pages are retained.';
    case 'source_unavailable': return 'The original PDF could not be read or verified. You can retry or import another available copy.';
    case 'user_cancelled': return 'Text extraction was stopped. Resume continues after the last saved page.';
    case 'confirmed_producer_loss': return 'The previous extraction stopped unexpectedly. Resume continues after the last saved page.';
    default: return 'Text extraction was interrupted. You can retry from the last saved page.';
  }
}

/** Render only the bounded text window returned by the controller. Offsets are
 * in stored normalized page UTF-16 coordinates, including mid-page results. */
function PageText({ controller }: { controller: Controller }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const window = state.textWindow;
  if (!window) return null;
  const start = Math.max(0, Math.min(window.text.length, (state.highlight?.start ?? 0) - window.startUTF16));
  const end = Math.max(start, Math.min(window.text.length, (state.highlight?.end ?? 0) - window.startUTF16));
  return <>
    {window.layout?.mode === 'source_order' &&
      <p>This page has an unsupported layout. Text follows the order stored in the PDF, which may differ from its visual reading order.</p>}
    {window.totalUTF16 > 0 && window.classification === 'possible_scanned' &&
      <p>This page contains little useful text and may include scanned images. The extracted text is shown below.</p>}
    {window.totalUTF16 === 0
      ? <p>This page has no extractable text. It may contain scanned images.</p>
      : <div className="document-text" aria-label="Extracted page text">
        {window.text.slice(0, start)}
        {end > start && <mark>{window.text.slice(start, end)}</mark>}
        {window.text.slice(end)}
      </div>}
    <div className="actions">
      <button disabled={state.loading || window.startUTF16 === 0}
        onClick={() => void controller.textWindow(0)}>Page text from start</button>
      <button disabled={state.loading || window.endUTF16 >= window.totalUTF16}
        onClick={() => void controller.textWindow(window.endUTF16)}>More page text</button>
    </div>
  </>;
}

export function DocumentPanel({ controller, workspaceId }: { controller: Controller; workspaceId: string | null }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [pageNumber, setPageNumber] = useState('1');
  const [clearTarget, setClearTarget] = useState<ClearPdfExtractionTarget | null>(null);
  useEffect(() => { setClearTarget(null); }, [state.document?.id]);
  useEffect(() => { setPageNumber(String(state.pageRef?.page ?? 1)); }, [state.pageRef?.page, state.document?.id]);
  const page = Number(pageNumber);
  const progress = state.progressDocId === state.document?.id ? state.progress : null;
  const pages = progress?.pages ?? state.run?.pageCount;
  const displayedPage = state.busy && progress ? progress.page : state.run?.completedPage ?? 0;
  const indexed = progress?.indexedThroughPage ?? 0;
  const locked = state.busy || !!state.pending || state.selectionChanged;
  const clearPending = state.pending?.kind === 'extraction' && state.pending.operation.operation === 'clearDocumentExtraction';
  const interrupted = state.run?.state === 'interrupted';
  const retry = interrupted && !['user_cancelled', 'confirmed_producer_loss'].includes(state.run?.failure ?? '');
  const status = state.busy
    ? state.pending ? 'Checking document operation' : progress?.phase === 'indexing' ? 'Making page text searchable' : progress ? 'Extracting text' : 'Saving document'
    : state.run?.state === 'completed' ? 'Text extraction complete'
      : retry ? 'Text extraction needs attention'
        : interrupted || state.run?.state === 'working' ? 'Extraction can be resumed'
        : 'Ready to extract text';
  return <section className="documents-panel" aria-label="Documents">
    <header>
      <h1>Documents</h1>
      <p>Keep original PDFs in your archive and search their text alongside your conversations.</p>
      <div className="actions">
        <button className="primary" disabled={!workspaceId || locked}
          onClick={() => workspaceId && void controller.import(workspaceId)}>Import PDF</button>
        <button disabled={state.loading || clearPending} onClick={() => void controller.refresh()}>Refresh documents</button>
      </div>
      <p className="muted">PDF files up to 32 MiB. Text extraction runs locally.</p>
    </header>
    {state.error && <p className="error" role="alert">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
    {state.pending && <button disabled={state.busy} onClick={() => void controller.reconcile()}>Check document operation</button>}
    {state.selectionChanged && <p role="status">The active archive changed. Document changes are paused in this view.</p>}
    {state.loading && <p role="status">Loading documents…</p>}
    <div className="document-layout">
      <nav aria-label="Document library">
        <ul className="document-list">{state.documents.map(document => <li key={document.id}>
          <button aria-current={state.document?.id === document.id ? 'true' : undefined}
            disabled={clearPending || state.busy && state.document?.id !== document.id}
            onClick={() => void controller.open(document.id)}>{document.title || 'Untitled document'}</button>
        </li>)}</ul>
        {!state.documents.length && !state.loading && <p>No documents in this view.</p>}
        <div className="actions">
          <button disabled={state.loading || clearPending} onClick={() => void controller.refresh()}>First documents</button>
          <button disabled={state.loading || clearPending || !state.nextCursor} onClick={() => state.nextCursor && void controller.refresh(state.nextCursor)}>Next documents</button>
        </div>
      </nav>
      {state.document && <article className="document-detail">
        <h2>{state.document.title || 'Untitled document'}</h2>
        <p>{state.attachment?.filename}</p>
        <div role="status" aria-live="polite">
          <p>{status}</p>
          {!state.busy && interrupted && <p>{interruptionMessage(state.run!.failure)}</p>}
          {(progress || state.run && state.run.state !== 'cleared') && <p>{displayedPage > 0
            ? `Page ${displayedPage}${pages ? ` / ${pages}` : ''}` : 'No pages saved yet.'}</p>}
          {indexed > 0 && <p>Text search available through page {indexed}.</p>}
        </div>
        <p className="muted">Semantic search is unavailable.</p>
        <div className="actions">
          <button disabled={locked || !!state.extractionUnavailableReason} onClick={() => void controller.extract()}>
            {state.run?.state === 'completed' ? 'Check text search' : retry ? 'Retry extraction' : state.run && state.run.state !== 'cleared' ? 'Resume extraction' : 'Extract text'}
          </button>
          {state.busy && <button onClick={() => controller.stop()}>Stop document work</button>}
        </div>
        {state.extractionUnavailableReason && <p>{state.extractionUnavailableReason}</p>}
        {state.run && state.run.state !== 'cleared' && <div className="document-recovery">
          <button disabled={locked || state.loading} onClick={() => setClearTarget({ documentId: state.document!.id,
            expectedRunId: state.run!.runId, expectedDocumentRevision: state.run!.documentRevision })}>Clear saved text…</button>
          {clearTarget && <div role="region" aria-label="Clear saved document text">
            <p>Remove saved text and document search entries for this PDF. The original file stays in your archive. You can extract it again from page one.</p>
            <div className="actions">
              <button disabled={locked || state.loading} onClick={() => { const target = clearTarget; setClearTarget(null); void controller.clearExtraction(target); }}>Clear saved text</button>
              <button disabled={locked} onClick={() => setClearTarget(null)}>Keep saved text</button>
            </div>
          </div>}
        </div>}
        <form className="document-page-form" onSubmit={event => { event.preventDefault(); void controller.page(page); }}>
          <label>Page number<input type="number" min={1} max={pages ?? undefined} step={1} value={pageNumber}
            onChange={event => setPageNumber(event.target.value)} /></label>
          <button disabled={state.loading || clearPending || !Number.isSafeInteger(page) || page < 1 || (!!pages && page > pages)}>Open page</button>
        </form>
        {state.pageRef && <section aria-label={`Document page ${state.pageRef.page}`}>
          <h3>Page {state.pageRef.page}</h3>
          <p className="muted">Extracted text from this page of the original PDF.</p>
          <PageText controller={controller} />
        </section>}
      </article>}
    </div>
  </section>;
}
