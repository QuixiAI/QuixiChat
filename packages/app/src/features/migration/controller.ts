import type { LibraryThread, StorageClient } from '@quixi/core/contracts';
import type { PortabilityInspection } from '../../workflows/chat.ts';
import type { GenerationSettings } from '../../workflows/chat.ts';
import type { ConfiguredProvider } from '../../runtime/library.ts';
import { describePortability, PORTABILITY_LABELS } from '../../runtime/portability.ts';
import type { PortabilityStatus } from '../../runtime/portability.ts';

/** Product §41 bulk migration, first half (plan 12): a paginated, bounded,
 * cancellable portability analysis of every conversation in the library
 * against the configured targets, with inspectable per-thread reasons and
 * per-thread failed outcomes that never stop the rest. Nothing is written. */
export const BULK_PAGE = { maxItems: 32, maxBytes: 65_536 } as const;
/** Rows retained for inspection; beyond this only the counts grow. */
export const BULK_ROW_LIMIT = 10_000;
export const BULK_BUSY_RETRIES = 40;
export type BulkOutcome = PortabilityStatus | 'failed' | 'empty';
export interface BulkRow {
  threadId: string;
  title: string;
  archived: boolean;
  outcome: BulkOutcome;
  label: string;
  summary: string;
  /** One inspectable reason per target, plus what is never sent; or the failure. */
  reasons: string[];
  targets: number;
  sendable: number;
}
export interface BulkSnapshot {
  state: 'idle' | 'running' | 'complete' | 'cancelled';
  analysed: number;
  counts: Record<BulkOutcome, number>;
  rows: BulkRow[];
  rowsTruncated: boolean;
  filter: BulkOutcome | 'all';
  /** Zero-based page of the filtered rows. */
  page: number;
  targets: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}
export interface BulkServices {
  storage: StorageClient;
  assess: (threadId: string, providers: readonly ConfiguredProvider[], parameters: GenerationSettings) => Promise<PortabilityInspection | null | 'busy'>;
  providers: () => readonly ConfiguredProvider[];
  settings: () => GenerationSettings;
  /** Yield between conversations so the interface and cancellation stay responsive. */
  yieldTurn?: () => Promise<void>;
}
const emptyCounts = (): Record<BulkOutcome, number> => ({ fully_portable: 0, portable_with_transformations: 0, provider_dependent: 0, blocked: 0, unknown: 0, failed: 0, empty: 0 });
export const BULK_LABELS: Record<BulkOutcome, string> = { ...PORTABILITY_LABELS, failed: 'Analysis failed', empty: 'No messages yet' };
const describeError = (error: unknown) => { const text = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error); return text.length > 300 ? `${text.slice(0, 299)}…` : text; };
export function createMigrationController(services: BulkServices) {
  let state: BulkSnapshot = { state: 'idle', analysed: 0, counts: emptyCounts(), rows: [], rowsTruncated: false, filter: 'all', page: 0, targets: 0, startedAt: null, finishedAt: null, error: null };
  const listeners = new Set<() => void>();
  let disposed = false, epoch = 0, active: Promise<void> | null = null;
  const publish = (patch: Partial<BulkSnapshot>) => { state = { ...state, ...patch }; if (!disposed) for (const listener of listeners) listener(); };
  const yieldTurn = services.yieldTurn ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const record = (row: BulkRow) => {
    const counts = { ...state.counts }; counts[row.outcome]++;
    const rows = state.rows.length < BULK_ROW_LIMIT ? [...state.rows, row] : state.rows;
    publish({ analysed: state.analysed + 1, counts, rows, rowsTruncated: state.rows.length >= BULK_ROW_LIMIT });
  };
  const analyse = async (current: number, thread: LibraryThread): Promise<BulkRow> => {
    const providers = services.providers(), settings = services.settings();
    const base = { threadId: thread.threadId, title: thread.title, archived: thread.archived };
    try {
      let result: PortabilityInspection | null | 'busy' = 'busy';
      for (let attempt = 0; result === 'busy' && attempt < BULK_BUSY_RETRIES; attempt++) {
        if (attempt) await new Promise<void>(resolve => setTimeout(resolve, 250));
        if (disposed || current !== epoch) throw new Error('Analysis stopped.');
        result = await services.assess(thread.threadId, providers, settings);
      }
      if (result === 'busy') return { ...base, outcome: 'failed', label: BULK_LABELS.failed, summary: 'A generation was in progress the whole time; retry when it finishes.', reasons: [], targets: 0, sendable: 0 };
      if (result === null || result.empty) return { ...base, outcome: 'empty', label: BULK_LABELS.empty, summary: 'The conversation has no sendable message on its selected branch.', reasons: [], targets: 0, sendable: 0 };
      const assessment = describePortability(result.targets, result.transformed, result.neverSent);
      return { ...base, outcome: assessment.status, label: assessment.label, summary: assessment.summary, reasons: assessment.reasons, targets: result.targets.length, sendable: result.targets.filter(target => target.report.sendable).length };
    } catch (error) {
      return { ...base, outcome: 'failed', label: BULK_LABELS.failed, summary: describeError(error), reasons: [], targets: 0, sendable: 0 };
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Walks the library page by page (active conversations, then archived), one conversation at a time. */
    start() {
      if (disposed || active) return Promise.resolve();
      const current = ++epoch;
      const targets = services.providers().reduce((sum, provider) => sum + provider.models.length, 0);
      publish({ state: 'running', analysed: 0, counts: emptyCounts(), rows: [], rowsTruncated: false, page: 0, targets, startedAt: Date.now(), finishedAt: null, error: null });
      const task = (async () => {
        try {
          for (const archived of [false, true]) {
            let cursor: string | null = null;
            do {
              if (disposed || current !== epoch) return;
              const page: { items: LibraryThread[]; nextCursor: string | null } = await services.storage.request(crypto.randomUUID(), 'listLibrary', { archived, title: '', page: { ...BULK_PAGE, cursor } });
              for (const thread of page.items) {
                if (disposed || current !== epoch) return;
                record(await analyse(current, thread));
                await yieldTurn();
              }
              cursor = page.nextCursor;
            } while (cursor);
          }
          if (!disposed && current === epoch) publish({ state: 'complete', finishedAt: Date.now() });
        } catch (error) {
          if (!disposed && current === epoch) publish({ state: 'cancelled', finishedAt: Date.now(), error: `The analysis stopped: ${describeError(error)} Start it again to continue.` });
        }
      })();
      active = task.finally(() => { if (active === task) active = null; });
      return active;
    },
    stop() {
      if (disposed || state.state !== 'running') return;
      epoch++;
      publish({ state: 'cancelled', finishedAt: Date.now() });
    },
    /** Re-analyses one failed conversation in place; other rows are untouched. */
    async retry(threadId: string) {
      if (disposed || state.state === 'running') return;
      const index = state.rows.findIndex(row => row.threadId === threadId);
      if (index < 0) return;
      const previous = state.rows[index]!;
      const current = epoch;
      const row = await analyse(current, { threadId, title: previous.title, archived: previous.archived, titleTruncated: false, tags: [], tagsTruncated: false, pinned: false, activityAt: 0, revision: 0 });
      if (disposed || current !== epoch) return;
      const counts = { ...state.counts }; counts[previous.outcome]--; counts[row.outcome]++;
      const rows = [...state.rows]; rows[index] = row;
      publish({ counts, rows });
    },
    setFilter(filter: BulkOutcome | 'all') { if (!disposed) publish({ filter, page: 0 }); },
    setPage(page: number) { if (!disposed) publish({ page: Math.max(0, page) }); },
    dispose() { disposed = true; epoch++; listeners.clear(); },
  };
}
export type MigrationController = ReturnType<typeof createMigrationController>;
