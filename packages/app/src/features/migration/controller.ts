import type { LibraryThread, StorageClient } from '@quixi/core/contracts';
import type { PortabilityInspection } from '../../workflows/chat.ts';
import type { GenerationSettings } from '../../workflows/chat.ts';
import type { ConfiguredProvider } from '../../runtime/library.ts';
import { describePortability, describeTransformations, PORTABILITY_LABELS } from '../../runtime/portability.ts';
import { parseRoutingProfile, routingProfileJson, EMPTY_ROUTING_PROFILE } from '../../runtime/routing.ts';
import type { JsonObject } from '@quixi/core/model';
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
  /** Per-target eligibility for a reviewed migration. */
  targetOutcomes: TargetOutcome[];
  /** The conversation's current primary connection and model, if any. */
  primary: { provider: string; model: string } | null;
  migrated: boolean;
}
export interface TargetOutcome { connection: string; provider: string; model: string; label: string; sendable: boolean; transformations: string[]; blocked: string[] }
export type MigrationOutcome = 'migrated' | 'blocked' | 'unchanged' | 'failed';
export interface MigrationResult { threadId: string; title: string; outcome: MigrationOutcome; reason: string }
export interface MigrationState {
  /** `connection|model`. */
  target: string | null;
  selected: string[];
  reviewing: boolean;
  running: boolean;
  results: MigrationResult[];
  finishedAt: number | null;
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
  migration: MigrationState;
}
export interface BulkServices {
  storage: StorageClient;
  assess: (threadId: string, providers: readonly ConfiguredProvider[], parameters: GenerationSettings) => Promise<PortabilityInspection | null | 'busy'>;
  providers: () => readonly ConfiguredProvider[];
  settings: () => GenerationSettings;
  /** Yield between conversations so the interface and cancellation stay responsive. */
  yieldTurn?: () => Promise<void>;
  /** Called after conversations were migrated so open views reload. */
  onMigrated?: (threadIds: string[]) => void;
}
const emptyCounts = (): Record<BulkOutcome, number> => ({ fully_portable: 0, portable_with_transformations: 0, provider_dependent: 0, blocked: 0, unknown: 0, failed: 0, empty: 0 });
export const BULK_LABELS: Record<BulkOutcome, string> = { ...PORTABILITY_LABELS, failed: 'Analysis failed', empty: 'No messages yet' };
const describeError = (error: unknown) => { const text = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error); return text.length > 300 ? `${text.slice(0, 299)}…` : text; };
export function createMigrationController(services: BulkServices) {
  const emptyMigration = (): MigrationState => ({ target: null, selected: [], reviewing: false, running: false, results: [], finishedAt: null });
  let state: BulkSnapshot = { state: 'idle', analysed: 0, counts: emptyCounts(), rows: [], rowsTruncated: false, filter: 'all', page: 0, targets: 0, startedAt: null, finishedAt: null, error: null, migration: emptyMigration() };
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
    const base = { threadId: thread.threadId, title: thread.title, archived: thread.archived, targetOutcomes: [] as TargetOutcome[], primary: null as BulkRow['primary'], migrated: false };
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
      const targetOutcomes: TargetOutcome[] = result.targets.map(target => ({
        connection: target.provider.id, provider: providers.find(provider => provider.id === target.provider.id)?.adapter?.binding?.providerId ?? target.provider.id, model: target.model.id,
        label: `${target.provider.label} · ${target.model.name}`, sendable: target.report.sendable,
        transformations: describeTransformations(target.transformed ?? result.transformed),
        blocked: [...target.report.blocked.map(item => `${item.kind ?? 'part'}: ${item.message}`), ...target.report.constraints.map(issue => issue.message)],
      }));
      const view = await services.storage.request(crypto.randomUUID(), 'readThreadView', { threadId: thread.threadId });
      const profile = parseRoutingProfile(view.state.routingProfile);
      return { ...base, outcome: assessment.status, label: assessment.label, summary: assessment.summary, reasons: assessment.reasons, targets: result.targets.length, sendable: result.targets.filter(target => target.report.sendable).length, targetOutcomes, primary: profile?.primary ? { provider: profile.primary.provider, model: profile.primary.model } : null };
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
      publish({ state: 'running', analysed: 0, counts: emptyCounts(), rows: [], rowsTruncated: false, page: 0, targets, startedAt: Date.now(), finishedAt: null, error: null, migration: emptyMigration() });
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
    /** Reviewed migration (ADR 0042): choose one target, tick conversations, review each one's outcome, then commit per conversation. */
    setMigrationTarget(target: string | null) { if (!disposed && !state.migration.running) publish({ migration: { ...state.migration, target, selected: [], reviewing: false, results: [], finishedAt: null } }); },
    toggleThread(threadId: string) {
      if (disposed || state.migration.running || state.migration.reviewing) return;
      const selected = state.migration.selected.includes(threadId) ? state.migration.selected.filter(value => value !== threadId) : [...state.migration.selected, threadId];
      publish({ migration: { ...state.migration, selected } });
    },
    /** Eligible: the chosen target can carry the conversation and is not already its primary. */
    eligible(row: BulkRow): { eligible: boolean; outcome: TargetOutcome | null } {
      const target = state.migration.target; if (!target) return { eligible: false, outcome: null };
      const [connection, model] = target.split('|');
      const outcome = row.targetOutcomes.find(item => item.connection === connection && item.model === model) ?? null;
      const already = !!row.primary && row.primary.provider === connection && row.primary.model === model;
      return { eligible: !!outcome && outcome.sendable && !already, outcome };
    },
    selectAllEligible() {
      if (disposed || state.migration.running || state.migration.reviewing) return;
      publish({ migration: { ...state.migration, selected: state.rows.filter(row => this.eligible(row).eligible).map(row => row.threadId) } });
    },
    reviewMigration() { if (!disposed && state.migration.target && state.migration.selected.length) publish({ migration: { ...state.migration, reviewing: true, results: [], finishedAt: null } }); },
    cancelReview() { if (!disposed) publish({ migration: { ...state.migration, reviewing: false } }); },
    async confirmMigration() {
      const migration = state.migration;
      if (disposed || migration.running || !migration.reviewing || !migration.target || !migration.selected.length) return;
      const [connection, model] = migration.target.split('|') as [string, string];
      const current = epoch;
      publish({ migration: { ...migration, running: true, results: [] } });
      const results: MigrationResult[] = [], migrated: string[] = [];
      for (const threadId of migration.selected) {
        if (disposed || current !== epoch || !state.migration.running) break;
        const row = state.rows.find(item => item.threadId === threadId);
        const title = row?.title ?? threadId;
        const { eligible, outcome } = row ? this.eligible(row) : { eligible: false, outcome: null };
        if (!row || !outcome) { results.push({ threadId, title, outcome: 'failed', reason: 'The conversation was not analysed against this target; analyse again.' }); }
        else if (!outcome.sendable) { results.push({ threadId, title, outcome: 'blocked', reason: outcome.blocked.join('; ') || 'The target cannot carry this conversation.' }); }
        else if (!eligible) { results.push({ threadId, title, outcome: 'unchanged', reason: 'This target is already the conversation\'s primary.' }); }
        else {
          try {
            const view = await services.storage.request(crypto.randomUUID(), 'readThreadView', { threadId });
            const previous = parseRoutingProfile(view.state.routingProfile);
            const next = { ...(previous ?? EMPTY_ROUTING_PROFILE), primary: { provider: connection, model } };
            const value = routingProfileJson(view.state.routingProfile, next);
            const now = Date.now(), id = () => crypto.randomUUID();
            const event = { id: id(), threadId, type: 'Migration' as const, createdAt: now, recordedAt: now, messageId: null, generationId: null,
              details: { version: 1, source: 'bulk-portability', from: previous?.primary ? { ...previous.primary } : null, to: { provider: connection, model }, providerId: outcome.provider, transformations: outcome.transformations } as unknown as JsonObject };
            await services.storage.request(id(), 'commit', {
              transactionId: id(), expectedThreadRevisions: [{ threadId, revision: view.state.revision }], stagedBlobIds: [],
              mutations: [
                { version: 1, operationId: id(), kind: 'SetRoutingProfile', recordedAt: now, payload: { threadId, value } },
                { version: 1, operationId: id(), kind: 'CreateThreadEvent', recordedAt: now, payload: { event } },
              ],
            } as never);
            results.push({ threadId, title, outcome: 'migrated', reason: outcome.transformations.length ? `Routed to ${outcome.label}; ${outcome.transformations.join('; ')}.` : `Routed to ${outcome.label}; every part carries as is.` });
            migrated.push(threadId);
          } catch (error) { results.push({ threadId, title, outcome: 'failed', reason: describeError(error) }); }
        }
        if (!disposed && current === epoch) publish({ migration: { ...state.migration, results: [...results] }, rows: state.rows.map(item => migrated.includes(item.threadId) ? { ...item, migrated: true, primary: { provider: connection, model } } : item) });
        await yieldTurn();
      }
      if (!disposed && current === epoch) publish({ migration: { ...state.migration, running: false, reviewing: false, selected: [], results, finishedAt: Date.now() } });
      if (migrated.length) services.onMigrated?.(migrated);
    },
    stopMigration() { if (!disposed && state.migration.running) publish({ migration: { ...state.migration, running: false } }); },
    setFilter(filter: BulkOutcome | 'all') { if (!disposed) publish({ filter, page: 0 }); },
    setPage(page: number) { if (!disposed) publish({ page: Math.max(0, page) }); },
    dispose() { disposed = true; epoch++; listeners.clear(); },
  };
}
export type MigrationController = ReturnType<typeof createMigrationController>;
