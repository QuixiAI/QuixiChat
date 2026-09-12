import { useSyncExternalStore } from 'react';
import type { MigrationController, BulkOutcome } from './controller.ts';
import { BULK_LABELS, BULK_PAGE } from './controller.ts';
import '../diagnostics/diagnostics.css';

const OUTCOMES: BulkOutcome[] = ['fully_portable', 'portable_with_transformations', 'provider_dependent', 'blocked', 'unknown', 'empty', 'failed'];
const duration = (from: number | null, to: number | null) => from === null ? '' : `${(((to ?? Date.now()) - from) / 1000).toFixed(1)} s`;
/** Product §37/§41: library-wide portability counts with inspectable reasons per conversation. */
export function MigrationPanel({ controller, onOpen, disabled = false }: { controller: MigrationController; onOpen: (threadId: string) => void; disabled?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const running = state.state === 'running';
  const filtered = state.filter === 'all' ? state.rows : state.rows.filter(row => row.outcome === state.filter);
  const pages = Math.max(1, Math.ceil(filtered.length / BULK_PAGE.maxItems)), page = Math.min(state.page, pages - 1);
  const visible = filtered.slice(page * BULK_PAGE.maxItems, (page + 1) * BULK_PAGE.maxItems);
  return <section className="storage-health migration" aria-label="Bulk portability">
    <h1>Bulk portability</h1>
    <p>Assess every conversation's selected branch against the configured connections: which can move anywhere as is, which need transformations, which depend on one provider, and which are blocked. Nothing is sent to a provider and nothing is changed; each reason is inspectable per conversation.</p>
    <div className="storage-health-actions">
      <button disabled={disabled || running} onClick={() => void controller.start()}>{state.state === 'idle' ? 'Analyse the library' : 'Analyse again'}</button>
      {running && <button onClick={() => controller.stop()}>Stop analysis</button>}
    </div>
    {state.error && <p role="alert">{state.error}</p>}
    {state.state !== 'idle' && <>
      <p role="status" aria-live="polite" data-testid="bulk-status">{running ? `Analysing… ${state.analysed.toLocaleString()} conversations so far` : state.state === 'complete' ? `Analysis complete: ${state.analysed.toLocaleString()} conversations against ${state.targets} target${state.targets === 1 ? '' : 's'} in ${duration(state.startedAt, state.finishedAt)}.` : `Analysis stopped after ${state.analysed.toLocaleString()} conversations.`}</p>
      <dl className="storage-health-counts" aria-label="Portability counts" data-testid="bulk-counts">
        <div data-outcome="total"><dt>Conversations</dt><dd>{state.analysed.toLocaleString()}</dd></div>
        {OUTCOMES.map(outcome => <div key={outcome} data-outcome={outcome}><dt>{BULK_LABELS[outcome]}</dt><dd>{state.counts[outcome].toLocaleString()}</dd></div>)}
      </dl>
      {state.rowsTruncated && <p>Only the first {state.rows.length.toLocaleString()} conversations are listed; the counts cover all of them.</p>}
      <div className="storage-health-actions" aria-label="Filter conversations">
        <label>Show <select value={state.filter} onChange={event => controller.setFilter(event.target.value as BulkOutcome | 'all')}>
          <option value="all">All outcomes</option>
          {OUTCOMES.map(outcome => <option key={outcome} value={outcome}>{BULK_LABELS[outcome]}</option>)}
        </select></label>
      </div>
      <ol className="storage-health-findings" aria-label="Conversation portability" start={page * BULK_PAGE.maxItems + 1} aria-busy={running}>
        {visible.map(row => <li key={row.threadId} data-outcome={row.outcome}>
          <h3>{row.title || 'Untitled conversation'}{row.archived ? ' (archived)' : ''}</h3>
          <p><strong>{row.label}.</strong> {row.summary}</p>
          {row.reasons.length > 0 && <details><summary>Reasons ({row.reasons.length})</summary><ul>{row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
          <div className="storage-health-actions">
            <button onClick={() => onOpen(row.threadId)}>Open conversation</button>
            {row.outcome === 'failed' && <button disabled={running} onClick={() => void controller.retry(row.threadId)}>Retry</button>}
          </div>
        </li>)}
      </ol>
      {filtered.length === 0 && <p>No conversations with this outcome.</p>}
      <div className="storage-health-actions" aria-label="Conversation pages">
        <button disabled={page === 0} onClick={() => controller.setPage(page - 1)}>Previous page</button>
        <span>Page {page + 1} of {pages}</span>
        <button disabled={page >= pages - 1} onClick={() => controller.setPage(page + 1)}>Next page</button>
      </div>
    </>}
  </section>;
}
