import test from 'node:test';
import assert from 'node:assert/strict';
import type { LibraryThread, StorageClient } from '@quixi/core/contracts';
import type { CompatibilityReport } from '@quixi/providers';
import { createMigrationController, BULK_PAGE } from '../../src/features/migration/controller.ts';
import type { PortabilityInspection } from '../../src/workflows/chat.ts';
import type { ConfiguredProvider } from '../../src/runtime/library.ts';

const thread = (index: number, archived = false): LibraryThread => ({ threadId: `t${index}`, title: `Thread ${index}`, titleTruncated: false, tags: [], tagsTruncated: false, pinned: false, archived, activityAt: index, revision: 1 });
const report = (sendable: boolean): CompatibilityReport => ({ target: { protocol: 'anthropic-messages', modelId: 'm' }, preserved: { parts: 2, byKind: {} }, blocked: sendable ? [] : [{ partId: null, kind: 'Image', code: 'unsupported', message: 'no images' }], constraints: [], requestBytes: 10, sendable, context: { contextWindow: null, maxOutputTokens: 1024, inputRoom: null }, pricing: null } as unknown as CompatibilityReport);
const inspection = (sendable: boolean[]): PortabilityInspection => ({ leaf: 'leaf', empty: false, targets: sendable.map((value, index) => ({ provider: { id: `p${index}`, label: `Provider ${index}` }, model: { id: 'm', name: 'Model' }, report: report(value) })), transformed: { inlinedBlobText: 0, unavailableImages: 0 }, neverSent: { internalProvenance: 0, emptyAssistant: 0 } });
async function until(read: () => boolean) { for (let at = 0; at < 400; at++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Test condition timed out'); }
function fixture(activeCount: number, archivedCount: number, outcomes: Record<string, PortabilityInspection | null | 'busy' | Error>) {
  const active = Array.from({ length: activeCount }, (_, index) => thread(index + 1)), archived = Array.from({ length: archivedCount }, (_, index) => thread(100 + index, true));
  const pages: { archived: boolean; cursor: string | null; maxItems: number }[] = [], assessed: string[] = [];
  const busyLeft = new Map<string, number>();
  const commits: { transactionId: string; expectedThreadRevisions: unknown[]; mutations: { kind: string; payload: unknown }[] }[] = [];
  const storage = { async request(_id: string, operation: string, args: { archived: boolean; page: { maxItems: number; cursor: string | null } }) {
    if (operation === 'readThreadView') return { state: { revision: 7, routingProfile: (args as unknown as { threadId: string }).threadId === 't3' ? { version: 3, primary: { provider: 'p0', model: 'm' }, alias: null, candidates: [], requirements: {}, allowPrivacyChange: false } : null } };
    if (operation === 'commit') { const batch = args as unknown as typeof commits[number]; if (batch.mutations.some(item => (item.payload as { threadId?: string }).threadId === 't4')) throw new Error('Synthetic commit failure'); commits.push(batch); return { transactionId: batch.transactionId, operations: [] }; }
    assert.equal(operation, 'listLibrary'); assert.equal(args.page.maxItems, BULK_PAGE.maxItems);
    pages.push({ archived: args.archived, cursor: args.page.cursor, maxItems: args.page.maxItems });
    const source = args.archived ? archived : active, offset = args.page.cursor ? Number(args.page.cursor) : 0;
    const items = source.slice(offset, offset + args.page.maxItems);
    return { items, nextCursor: offset + items.length < source.length ? String(offset + items.length) : null, bytes: 1 };
  } } as unknown as StorageClient;
  const providers: ConfiguredProvider[] = [{ id: 'p0', label: 'Provider 0', adapter: {} as never, models: [{ id: 'm', name: 'Model' } as never] }];
  const controller = createMigrationController({
    storage, providers: () => providers, settings: () => ({ maxOutputTokens: 1024 }), yieldTurn: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    async assess(threadId) {
      assessed.push(threadId);
      const outcome: PortabilityInspection | null | 'busy' | Error = threadId in outcomes ? outcomes[threadId]! : inspection([true]);
      if (outcome === 'busy') { const left = busyLeft.get(threadId) ?? 2; busyLeft.set(threadId, left - 1); return left > 0 ? 'busy' : inspection([true]); }
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  return { controller, pages, assessed, commits };
}
test('the library is walked page by page, active then archived, with counts per outcome and inspectable rows', async () => {
  const f = fixture(70, 3, { t2: inspection([true, false]), t3: inspection([false]), t5: null, t7: new Error('Synthetic read failure'), t9: 'busy' });
  await f.controller.start();
  const state = f.controller.getSnapshot();
  assert.equal(state.state, 'complete'); assert.equal(state.analysed, 73);
  assert.deepEqual(state.counts, { fully_portable: 69, portable_with_transformations: 0, provider_dependent: 1, blocked: 1, unknown: 0, failed: 1, empty: 1 });
  assert.deepEqual(f.pages.map(page => `${page.archived ? 'a' : 'l'}:${page.cursor ?? '0'}`), ['l:0', 'l:32', 'l:64', 'a:0']);
  const rows = Object.fromEntries(state.rows.map(row => [row.threadId, row]));
  assert.equal(rows.t2!.outcome, 'provider_dependent'); assert.equal(rows.t2!.sendable, 1); assert.equal(rows.t2!.targets, 2); assert.ok(rows.t2!.reasons.some(reason => /blocked/.test(reason)));
  assert.equal(rows.t3!.outcome, 'blocked'); assert.equal(rows.t5!.outcome, 'empty');
  assert.equal(rows.t7!.outcome, 'failed'); assert.equal(rows.t7!.summary, 'Synthetic read failure');
  assert.equal(rows.t9!.outcome, 'fully_portable', 'a busy workflow is retried');
  assert.equal(rows.t100!.archived, true);
  assert.equal(f.assessed.filter(value => value === 't9').length, 3);
});
test('stopping keeps what was analysed; retry re-analyses one failed conversation in place', async () => {
  const f = fixture(40, 0, { t1: new Error('first pass fails') });
  const started = f.controller.start();
  await until(() => f.controller.getSnapshot().analysed >= 5);
  f.controller.stop(); await started;
  const stopped = f.controller.getSnapshot();
  assert.equal(stopped.state, 'cancelled'); assert.ok(stopped.analysed >= 5 && stopped.analysed < 40, `analysed ${stopped.analysed}`);
  assert.equal(stopped.rows[0]!.outcome, 'failed');
  await f.controller.retry('t1');
  assert.equal(f.controller.getSnapshot().rows[0]!.outcome, 'failed', 'the same failure again');
  const g = fixture(2, 0, { t1: new Error('flaky') });
  await g.controller.start();
  assert.equal(g.controller.getSnapshot().counts.failed, 1);
  // The failure clears: retry replaces the row and moves the count.
  const patched = createMigrationController({ storage: { async request(_id: string, operation: string, args: { archived: boolean }) { if (operation === 'readThreadView') return { state: { revision: 1, routingProfile: null } }; return { items: args.archived ? [] : [thread(1)], nextCursor: null, bytes: 1 }; } } as unknown as StorageClient, providers: () => [], settings: () => ({ maxOutputTokens: 1024 }), yieldTurn: async () => {}, assess: (() => { let calls = 0; return async () => { calls++; if (calls === 1) throw new Error('flaky'); return inspection([true]); }; })() });
  await patched.start();
  assert.equal(patched.getSnapshot().counts.failed, 1);
  await patched.retry('t1');
  assert.deepEqual([patched.getSnapshot().counts.failed, patched.getSnapshot().counts.fully_portable], [0, 1]);
});
test('reviewed migration: eligibility per target, review before commit, one SetRoutingProfile and Migration event per conversation against its revision, blocked and failed outcomes kept', async () => {
  const f = fixture(4, 0, { t1: inspection([true, true]), t2: inspection([true, false]), t3: inspection([true, true]), t4: inspection([true, true]) });
  await f.controller.start();
  const c = f.controller;
  assert.deepEqual(c.getSnapshot().rows.map(row => [row.threadId, row.targetOutcomes.map(outcome => `${outcome.connection}:${outcome.sendable}`).join(','), row.primary?.provider ?? null]), [['t1', 'p0:true,p1:true', null], ['t2', 'p0:true,p1:false', null], ['t3', 'p0:true,p1:true', 'p0'], ['t4', 'p0:true,p1:true', null]]);
  c.setMigrationTarget('p1|m');
  assert.deepEqual(c.getSnapshot().rows.map(row => c.eligible(row).eligible), [true, false, true, true]);
  c.setMigrationTarget('p0|m');
  assert.deepEqual(c.getSnapshot().rows.map(row => c.eligible(row).eligible), [true, true, false, true], 'already-primary is not eligible');
  c.setMigrationTarget('p1|m');
  c.selectAllEligible(); c.toggleThread('t2');
  assert.deepEqual(c.getSnapshot().migration.selected, ['t1', 't3', 't4', 't2']);
  await c.confirmMigration();
  assert.equal(f.commits.length, 0, 'nothing is committed without a review');
  c.reviewMigration(); assert.equal(c.getSnapshot().migration.reviewing, true);
  await c.confirmMigration();
  const migration = c.getSnapshot().migration;
  assert.equal(migration.running, false); assert.equal(migration.reviewing, false);
  assert.deepEqual(migration.results.map(result => [result.threadId, result.outcome]), [['t1', 'migrated'], ['t3', 'migrated'], ['t4', 'failed'], ['t2', 'blocked']]);
  assert.equal(f.commits.length, 2);
  for (const batch of f.commits) {
    assert.deepEqual(batch.expectedThreadRevisions, [{ threadId: (batch.mutations[0]!.payload as { threadId: string }).threadId, revision: 7 }]);
    assert.deepEqual(batch.mutations.map(item => item.kind), ['SetRoutingProfile', 'CreateThreadEvent']);
    const value = (batch.mutations[0]!.payload as { value: { primary: unknown } }).value; assert.deepEqual(value.primary, { provider: 'p1', model: 'm' });
    const event = (batch.mutations[1]!.payload as { event: { type: string; details: { to: unknown; from: unknown; source: string } } }).event;
    assert.equal(event.type, 'Migration'); assert.deepEqual(event.details.to, { provider: 'p1', model: 'm' }); assert.equal(event.details.source, 'bulk-portability');
  }
  assert.deepEqual(f.commits.map(batch => (batch.mutations[1]!.payload as { event: { details: { from: unknown } } }).event.details.from), [null, { provider: 'p0', model: 'm' }]);
  assert.deepEqual(c.getSnapshot().rows.filter(row => row.migrated).map(row => row.threadId), ['t1', 't3']);
  assert.equal(c.eligible(c.getSnapshot().rows[0]!).eligible, false, 'a migrated conversation is not eligible again');
});
test('filter and page selection are view state; dispose stops a running analysis', async () => {
  const f = fixture(5, 0, {});
  await f.controller.start();
  f.controller.setFilter('blocked'); f.controller.setPage(3);
  assert.equal(f.controller.getSnapshot().filter, 'blocked'); assert.equal(f.controller.getSnapshot().page, 3);
  const g = fixture(200, 0, {});
  const started = g.controller.start();
  await until(() => g.controller.getSnapshot().analysed >= 3);
  g.controller.dispose(); await started;
  assert.ok(g.controller.getSnapshot().analysed < 200);
});
