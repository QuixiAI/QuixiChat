import { useSyncExternalStore } from 'react';
import type { MigrationController, BulkOutcome } from './controller.ts';
import { BULK_LABELS, BULK_PAGE } from './controller.ts';
import '../diagnostics/diagnostics.css';

const OUTCOMES: BulkOutcome[] = ['fully_portable', 'portable_with_transformations', 'provider_dependent', 'blocked', 'unknown', 'empty', 'failed'];
const duration = (from: number | null, to: number | null) => from === null ? '' : `${(((to ?? Date.now()) - from) / 1000).toFixed(1)} s`;
/** Product §37/§41: library-wide portability counts with inspectable reasons per conversation. */
export function MigrationPanel({ controller, onOpen, targets, disabled = false }: { controller: MigrationController; onOpen: (threadId: string) => void; targets: { key: string; label: string }[]; disabled?: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const running = state.state === 'running';
  const migration = state.migration, migrating = migration.running;
  const targetLabel = targets.find(target => target.key === migration.target)?.label ?? '';
  const eligibleRows = migration.target ? state.rows.filter(row => controller.eligible(row).eligible) : [];
  const selectedRows = migration.selected.map(threadId => state.rows.find(row => row.threadId === threadId)).filter((row): row is NonNullable<typeof row> => !!row);
  const resultCounts = migration.results.reduce<Record<string, number>>((counts, result) => ({ ...counts, [result.outcome]: (counts[result.outcome] ?? 0) + 1 }), {});
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
          <h3>{row.title || 'Untitled conversation'}{row.archived ? ' (archived)' : ''}{row.migrated && <span className="compare-selected"> · Migrated</span>}</h3>
          {state.state === 'complete' && migration.target && (() => { const { eligible, outcome } = controller.eligible(row); return outcome
            ? <label className="storage-health-select"><input type="checkbox" checked={migration.selected.includes(row.threadId)} disabled={!eligible || migrating || migration.reviewing} onChange={() => controller.toggleThread(row.threadId)} /> {eligible ? `Migrate to ${outcome.label}` : outcome.sendable ? (row.migrated ? `Migrated to ${outcome.label}` : `${outcome.label} is already the primary`) : `${outcome.label} cannot carry this conversation`}</label>
            : <p className="muted">Not analysed against {targetLabel}; analyse again.</p>; })()}
          <p><strong>{row.label}.</strong> {row.summary}</p>
          {row.reasons.length > 0 && <details><summary>Reasons ({row.reasons.length})</summary><ul>{row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
          <div className="storage-health-actions">
            <button onClick={() => onOpen(row.threadId)}>Open conversation</button>
            {row.outcome === 'failed' && <button disabled={running} onClick={() => void controller.retry(row.threadId)}>Retry</button>}
          </div>
        </li>)}
      </ol>
      {filtered.length === 0 && <p>No conversations with this outcome.</p>}
      {state.state === 'complete' && <section aria-label="Reviewed migration" className="storage-health-cleanup" data-testid="bulk-migration">
        <h2>Reviewed migration</h2>
        <p>Choose a target, tick the conversations to move, review what each one would carry, then confirm. Migration changes only each conversation's routing (the connection it continues with); no message, answer or attachment is altered, and a Migration event records the change per conversation.</p>
        <div className="storage-health-actions">
          <label>Target <select aria-label="Migration target" value={migration.target ?? ''} disabled={migrating || migration.reviewing} onChange={event => controller.setMigrationTarget(event.target.value || null)}>
            <option value="">Choose a target</option>
            {targets.map(target => <option key={target.key} value={target.key}>{target.label}</option>)}
          </select></label>
          <button disabled={!migration.target || migrating || migration.reviewing || !eligibleRows.length} onClick={() => controller.selectAllEligible()}>Select all eligible ({eligibleRows.length})</button>
          <button disabled={!migration.target || migrating || migration.reviewing || !migration.selected.length} onClick={() => controller.reviewMigration()}>Review migration…</button>
        </div>
        <p data-testid="migration-scope">{!migration.target ? 'No target chosen.' : `${migration.selected.length} of ${eligibleRows.length} eligible conversations selected for ${targetLabel}; ${state.rows.filter(row => { const { outcome } = controller.eligible(row); return outcome && !outcome.sendable; }).length} cannot be carried by it.`}</p>
        {migration.reviewing && <div role="group" aria-labelledby="migration-review-title" className="storage-health-review" data-testid="migration-review">
          <h3 id="migration-review-title">Route {migration.selected.length} conversation{migration.selected.length === 1 ? '' : 's'} to {targetLabel}?</h3>
          <p>Each conversation's routing profile will name this connection and model as its primary; a Migration event is recorded per conversation. Nothing else changes, and another reviewed migration can route them elsewhere again.</p>
          <ol className="storage-health-scope">{selectedRows.map(row => { const { outcome } = controller.eligible(row); return <li key={row.threadId}>{row.title || 'Untitled conversation'} — {outcome?.transformations.length ? outcome.transformations.join('; ') : 'every part carries as is'}</li>; })}</ol>
          <div className="storage-health-actions">
            <button className="primary" disabled={migrating} onClick={() => void controller.confirmMigration()}>{migrating ? 'Migrating…' : `Migrate ${migration.selected.length} conversation${migration.selected.length === 1 ? '' : 's'}`}</button>
            {migrating ? <button onClick={() => controller.stopMigration()}>Stop</button> : <button onClick={() => controller.cancelReview()}>Keep the current routing</button>}
          </div>
        </div>}
        {migration.results.length > 0 && <div role="status" data-testid="migration-result">
          <p>{migrating ? 'Migrating…' : 'Migration finished.'} {resultCounts.migrated ?? 0} migrated, {resultCounts.blocked ?? 0} blocked, {resultCounts.unchanged ?? 0} unchanged, {resultCounts.failed ?? 0} failed.</p>
          <ul className="storage-health-scope">{migration.results.map(result => <li key={result.threadId} data-outcome={result.outcome}>{result.title || 'Untitled conversation'}: <strong>{result.outcome}</strong> — {result.reason}</li>)}</ul>
        </div>}
      </section>}
      <div className="storage-health-actions" aria-label="Conversation pages">
        <button disabled={page === 0} onClick={() => controller.setPage(page - 1)}>Previous page</button>
        <span>Page {page + 1} of {pages}</span>
        <button disabled={page >= pages - 1} onClick={() => controller.setPage(page + 1)}>Next page</button>
      </div>
    </>}
  </section>;
}
