import test from 'node:test';
import assert from 'node:assert/strict';
import type { MutationBatch, StorageClient, ThreadView } from '@quixi/core/contracts';
import { createLibraryController, type AppServices } from '../src/runtime/library.ts';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    assert(performance.now() < deadline, 'Controller did not reach the expected state within two seconds.');
    await pause(5);
  }
}

function fixture(options: { groupedParts?: boolean; archiveSelection?: boolean; commitFailure?: string;
  onCommit?: (batch: MutationBatch, attempt: number) => Promise<void>;
  onLibrary?: (read: number) => Promise<void>;
  previousResult?: 'committed' | 'not_committed'; } = {}) {
  const commits: MutationBatch[] = [], previousChecks: (readonly string[])[] = [];
  const windows: { threadId: string; leafMessageId: string | null }[] = [];
  const reads: { threadId: string; view: ThreadView; resolve: (view: ThreadView) => void; reject: (error: Error) => void }[] = [];
  const parts: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const operations: string[] = [];
  let changed: (() => void) | null = null;
  let selectionChanged: (() => void) | null = null;
  let libraryReads = 0;
  const storage = {
    async request(_requestId: string, operation: string, args: unknown) {
      operations.push(operation);
      if (operation === 'commit') {
        commits.push(structuredClone(args) as MutationBatch);
        if (commits.length === 1 && options.commitFailure) throw Object.assign(new Error('Synthetic commit refusal'), { code: options.commitFailure });
        await options.onCommit?.(args as MutationBatch, commits.length);
        return {};
      }
      if (operation === 'archiveWorkspace') return { workspaceId: crypto.randomUUID() };
      if (operation === 'listLibrary') await options.onLibrary?.(++libraryReads);
      if (operation === 'readThreadView') {
        const { threadId } = args as { threadId: string };
        // Only the fields consumed by the real controller are needed for empty conversations.
        const view = { thread: { id: threadId, importSourceId: null },
          state: { activeLeafMessageId: null, revision: reads.length, title: `Thread ${threadId}` }, context: { id: crypto.randomUUID() } } as ThreadView;
        return new Promise<ThreadView>((resolve, reject) => reads.push({ threadId, view, resolve, reject }));
      }
      if (operation === 'readConversationWindow') windows.push(args as { threadId: string; leafMessageId: string | null });
      if (operation === 'readConversationWindow' && options.groupedParts) {
        return { items: [0, 1].map(() => ({ id: crypto.randomUUID(), generationId: null })), nextCursor: null, bytes: 200 };
      }
      if (operation === 'readMessageParts') {
        return new Promise<unknown>((resolve, reject) => parts.push({
          resolve: () => resolve({ items: [], nextCursor: null, bytes: 2 }), reject,
        }));
      }
      if (['listLibrary', 'readConversationWindow', 'readEntities', 'readMessageChildren', 'searchArchive'].includes(operation)) {
        return { items: [], nextCursor: null, bytes: 2 };
      }
      assert.fail(`Unexpected storage operation: ${operation}`);
    },
    onChange(listener: () => void) { changed = listener; return () => { changed = null; }; },
  } as unknown as StorageClient;
  const archiveSession = options.archiveSelection ? {
    onSelectionChange(listener: () => void) { selectionChanged = listener; return () => { selectionChanged = null; }; },
    async reconcilePreviousOperations(operationIds: readonly string[]) { previousChecks.push([...operationIds]); return options.previousResult ?? 'committed'; },
  } : undefined;
  const controller = createLibraryController({ storage, archiveSession } as AppServices);
  const complete = (index: number) => { const read = reads[index]!; read.resolve(read.view); };
  return { controller, reads, parts, operations, commits, windows, previousChecks, complete, notify: () => changed?.(), selectArchive: () => selectionChanged?.() };
}

test('notifications during a slow automatic view publish that view and coalesce into one followup', { timeout: 5_000 }, async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID());
  f.complete(0); await opened;
  f.notify(); await until(() => f.reads.length === 2);
  for (let cycle = 0; cycle < 2; cycle++) {
    for (let change = 0; change < 10; change++) f.notify();
    await pause(240);
    assert.equal(f.reads.length, 2, 'Notifications must not supersede an active automatic view.');
  }
  f.complete(1); await flush();
  assert.equal(f.controller.getSnapshot().thread, f.reads[1]!.view, 'Slow view must publish before its followup.');
  await until(() => f.reads.length === 3);
  f.complete(2); await flush();
  assert.equal(f.controller.getSnapshot().thread, f.reads[2]!.view);
  await pause(260);
  assert.equal(f.reads.length, 3, 'All notifications during the active read require only one followup.');
});

test('notifications during initial explicit navigation wait for publication before automatic refresh', { timeout: 3_000 }, async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID());
  f.notify(); await pause(260);
  assert.equal(f.reads.length, 1);
  f.complete(0); await opened;
  assert.equal(f.controller.getSnapshot().thread, f.reads[0]!.view);
  await until(() => f.reads.length === 2);
  f.complete(1); await flush();
});

test('latest explicit navigation wins over an older slow view and its queued notification', { timeout: 3_000 }, async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const oldOpen = f.controller.open(crypto.randomUUID());
  f.notify();
  const newOpen = f.controller.open(crypto.randomUUID());
  assert.equal(f.reads.length, 2, 'Explicit navigation must not wait for an older load.');
  f.complete(1); await newOpen;
  f.complete(0); await oldOpen;
  assert.equal(f.controller.getSnapshot().thread, f.reads[1]!.view);
  await pause(260);
  assert.equal(f.reads.length, 2, 'Explicit navigation consumes the earlier queued refresh.');
});

test('an older navigation failure cannot overwrite the current view error state', async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const oldOpen = f.controller.open(crypto.randomUUID());
  const newOpen = f.controller.open(crypto.randomUUID());
  f.complete(1); await newOpen;
  f.reads[0]!.reject(new Error('Synthetic stale read failure.')); await oldOpen;
  assert.equal(f.controller.getSnapshot().thread, f.reads[1]!.view);
  assert.equal(f.controller.getSnapshot().error, null);
});

test('a failed automatic read does not busy retry, and a later notification can recover', { timeout: 3_000 }, async t => {
  const f = fixture(); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  f.notify(); await until(() => f.reads.length === 2);
  f.reads[1]!.reject(new Error('Synthetic current read failure.')); await flush();
  assert.notEqual(f.controller.getSnapshot().error, null);
  assert.equal(f.controller.getSnapshot().thread, f.reads[0]!.view);
  await pause(460);
  assert.equal(f.reads.length, 2, 'A failure alone must not schedule another read.');
  f.notify(); await until(() => f.reads.length === 3);
  f.complete(2); await flush();
  assert.equal(f.controller.getSnapshot().thread, f.reads[2]!.view);
});

test('a failed grouped part read keeps the automatic refresh slot until its held sibling settles', { timeout: 3_000 }, async t => {
  const f = fixture({ groupedParts: true }); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID());
  f.complete(0); await until(() => f.parts.length === 2);
  f.notify(); f.parts[0]!.reject(new Error('Synthetic grouped read failure.'));
  await pause(260);
  assert.equal(f.reads.length, 1, 'The rejected member cannot release the slot while its sibling remains active.');
  f.parts[1]!.resolve(); await opened;
  assert.notEqual(f.controller.getSnapshot().error, null);
  await until(() => f.reads.length === 2);
  f.complete(1); await until(() => f.parts.length === 4);
  f.parts[2]!.resolve(); f.parts[3]!.resolve(); await flush();
  assert.equal(f.controller.getSnapshot().thread, f.reads[1]!.view);
  await pause(260);
  assert.equal(f.reads.length, 2);
});

test('dispose cancels a pending automatic timer without further reads or publications', { timeout: 3_000 }, async () => {
  const f = fixture();
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  f.notify();
  const snapshot = f.controller.getSnapshot(), operationCount = f.operations.length;
  let publications = 0; f.controller.subscribe(() => publications++);
  f.controller.dispose(); f.notify();
  await pause(260);
  assert.equal(f.operations.length, operationCount);
  assert.equal(f.controller.getSnapshot(), snapshot);
  assert.equal(publications, 0);
});

test('dispose during an automatic read prevents later stages and a dirty followup', { timeout: 3_000 }, async () => {
  const f = fixture();
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  f.notify(); await until(() => f.reads.length === 2);
  f.notify();
  const snapshot = f.controller.getSnapshot(), operationCount = f.operations.length;
  let publications = 0; f.controller.subscribe(() => publications++);
  f.controller.dispose(); f.complete(1);
  await pause(260);
  assert.equal(f.operations.length, operationCount, 'An abandoned view must not request subsequent storage stages.');
  assert.equal(f.controller.getSnapshot(), snapshot);
  assert.equal(publications, 0);
});

test('archive selection change suppresses a pending automatic refresh and subsequent notifications', { timeout: 3_000 }, async t => {
  const f = fixture({ archiveSelection: true }); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  f.notify(); f.selectArchive();
  const operationCount = f.operations.length;
  await pause(260);
  assert.equal(f.operations.length, operationCount, 'The pending timer must not refresh an archive after selection changes.');
  for (let change = 0; change < 10; change++) f.notify();
  await pause(260);
  assert.equal(f.operations.length, operationCount, 'Later notifications must not schedule work for the old archive.');
  assert.equal(f.controller.getSnapshot().thread, f.reads[0]!.view);
});


for (const code of ['UNKNOWN_OUTCOME', 'QUOTA_EXCEEDED']) {
  test(`dismiss preserves reconciliation for ${code === 'UNKNOWN_OUTCOME' ? 'unknown outcomes' : 'known refusals without retaining an error'}`, async t => {
    const f = fixture({ commitFailure: code }); t.after(() => f.controller.dispose());
    await f.controller.initialize();
    const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
    await f.controller.update('SetTitle', 'Reviewed new title');
    const failed = f.controller.getSnapshot();
    assert.notEqual(failed.error, null);
    assert.equal(failed.pendingMutation, code === 'UNKNOWN_OUTCOME');
    f.controller.dismissError();
    if (code === 'UNKNOWN_OUTCOME') {
      assert.equal(f.controller.getSnapshot().error, null, 'Ordinary errors can now be dismissed independently.');
      assert.equal(f.controller.getSnapshot().pendingRecovery, failed.pendingRecovery);
      assert.equal(failed.pendingRecovery?.threadId, f.reads[0]!.threadId);
      assert.equal(failed.pendingRecovery?.threadTitle, `Thread ${f.reads[0]!.threadId}`);
      assert(Object.isFrozen(failed.pendingRecovery));
      const reconciled = f.controller.reconcile();
      assert.equal(f.controller.getSnapshot().pendingRecovery?.checking, true);
      await until(() => f.reads.length === 2); f.complete(1); await reconciled;
      assert.equal(f.commits.length, 2);
      assert.deepEqual(f.commits[1], f.commits[0], 'Recovery replays the same transaction and mutations.');
    } else {
      assert.equal(failed.pendingRecovery, null);
      assert.equal(f.controller.getSnapshot().error, null);
      await f.controller.reconcile();
      assert.equal(f.commits.length, 1, 'A known refusal has no transaction awaiting replay.');
    }
    assert.equal(f.controller.getSnapshot().pendingMutation, false);
    assert.equal(f.controller.getSnapshot().pendingRecovery, null);
    assert.equal(f.controller.getSnapshot().error, null);
  });
}

test('pending recovery survives navigation, search, ordinary read errors and dismissal', async t => {
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME' }); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const origin = crypto.randomUUID(), destination = crypto.randomUUID(), leaf = crypto.randomUUID();
  const first = f.controller.open(origin); f.complete(0); await first;
  await f.controller.update('SetTitle', 'Pending title');
  const recovery = f.controller.getSnapshot().pendingRecovery!;
  const next = f.controller.open(destination, leaf); f.complete(1); await next;
  await f.controller.search('pending source');
  assert.equal(f.controller.getSnapshot().query, 'pending source');
  assert.equal(f.controller.getSnapshot().pendingRecovery, recovery);
  const failed = f.controller.open(crypto.randomUUID());
  f.reads[2]!.reject(new Error('Unrelated navigation failure.')); await failed;
  assert.match(f.controller.getSnapshot().error!, /Unrelated/);
  f.controller.dismissError();
  assert.equal(f.controller.getSnapshot().pendingRecovery, recovery);
  assert.equal(f.controller.getSnapshot().pendingMutation, true);
  const retry = f.controller.reconcile();
  await until(() => f.reads.length === 4); f.complete(3); await retry;
  assert.equal(f.reads[3]!.threadId, destination);
  assert.equal(f.controller.getSnapshot().thread!.thread.id, destination);
  assert.equal(f.controller.getSnapshot().leaf, leaf);
  assert.equal(f.controller.getSnapshot().query, 'pending source');
  assert.deepEqual(f.commits[1], f.commits[0]);
  assert.equal(f.controller.getSnapshot().pendingRecovery, null);
});

test('concurrent checks share one held replay and preserve navigation and a newer same-text error', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME', onCommit: async () => held });
  t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  await f.controller.update('SetTitle', 'Pending title');
  const initialError = f.controller.getSnapshot().error!;
  const first = f.controller.reconcile(), second = f.controller.reconcile();
  assert.equal(first, second);
  await until(() => f.commits.length === 2);
  assert.equal(f.controller.getSnapshot().pendingRecovery?.checking, true);
  const destination = crypto.randomUUID(), leaf = crypto.randomUUID();
  const next = f.controller.open(destination, leaf); f.complete(1); await next;
  await f.controller.search('new selection');
  f.controller.patch({ error: initialError });
  release(); await first;
  assert.equal(f.commits.length, 2);
  assert.deepEqual(f.commits[1], f.commits[0]);
  assert.equal(f.reads.length, 2, 'Recovery must not start a view read after a newer navigation.');
  assert.equal(f.controller.getSnapshot().thread!.thread.id, destination);
  assert.equal(f.controller.getSnapshot().leaf, leaf);
  assert.equal(f.controller.getSnapshot().error, initialError, 'A newer error must survive even when its text equals the old error.');
  assert.equal(f.controller.getSnapshot().pendingRecovery, null);
});

test('a failed check retains the original recovery and another exact retry can resolve it', async t => {
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME', onCommit: async (_batch, attempt) => {
    if (attempt === 2) throw Object.assign(new Error('Synthetic failed check'), { code: 'IO_ERROR' });
  } });
  t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  await f.controller.update('SetTitle', 'Pending title');
  const origin = f.controller.getSnapshot().pendingRecovery!;
  f.controller.dismissError();
  await f.controller.reconcile();
  const failed = f.controller.getSnapshot();
  assert.equal(failed.pendingMutation, true);
  assert.equal(failed.pendingRecovery?.checking, false);
  assert.equal(failed.pendingRecovery?.threadId, origin.threadId);
  assert.equal(failed.pendingRecovery?.threadTitle, origin.threadTitle);
  assert.match(failed.pendingRecovery!.message, /still unknown/);
  assert.equal(failed.error, null);
  const retry = f.controller.reconcile();
  await until(() => f.reads.length === 2); f.complete(1); await retry;
  assert.deepEqual(f.commits[1], f.commits[0]); assert.deepEqual(f.commits[2], f.commits[0]);
  assert.equal(f.controller.getSnapshot().pendingMutation, false);
  assert.equal(f.controller.getSnapshot().pendingRecovery, null);
});

test('replaying a branch change preserves a newer explicit leaf in the same conversation', async t => {
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME' }); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const threadId = crypto.randomUUID(), intendedLeaf = crypto.randomUUID(), newerLeaf = crypto.randomUUID();
  const opened = f.controller.open(threadId); f.complete(0); await opened;
  await f.controller.selectBranch(intendedLeaf);
  const next = f.controller.open(threadId, newerLeaf); f.complete(1); await next;
  const retry = f.controller.reconcile();
  await until(() => f.reads.length === 3); f.complete(2); await retry;
  assert.equal(f.windows.at(-1)!.leafMessageId, newerLeaf);
  assert.equal(f.controller.getSnapshot().leaf, newerLeaf);
  assert.deepEqual(f.commits[1], f.commits[0]);
});

test('retained transaction and originating metadata are independent of caller mutation', async t => {
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME', onCommit: async batch => {
    assert(Object.isFrozen(batch)); assert(Object.isFrozen(batch.mutations[0]!.payload));
  } }); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const threadId = crypto.randomUUID(), opened = f.controller.open(threadId); f.complete(0); await opened;
  const mutation = f.controller.mutation('SetTitle', { threadId, value: 'Original intent' });
  await assert.rejects(f.controller.commit([mutation], { threadId, revision: 0 }));
  const recovery = f.controller.getSnapshot().pendingRecovery!;
  mutation.payload.value = 'Later caller mutation';
  f.controller.getSnapshot().thread!.state.title = 'Later displayed title';
  assert.equal(recovery.threadTitle, `Thread ${threadId}`);
  const retry = f.controller.reconcile();
  await until(() => f.reads.length === 2); f.complete(1); await retry;
  assert.deepEqual(f.commits[1], f.commits[0]);
});

for (const previousResult of ['committed', 'not_committed'] as const) {
  test(`archive-selection changes reconcile only the original operation IDs (${previousResult})`, async t => {
    const f = fixture({ archiveSelection: true, previousResult, commitFailure: 'UNKNOWN_OUTCOME', onCommit: async () => {
      throw Object.assign(new Error('Original archive connection closed'), { code: 'CLOSED' });
    } }); t.after(() => f.controller.dispose());
    await f.controller.initialize();
    const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
    await f.controller.update('SetTitle', 'Pending old-archive title');
    f.selectArchive();
    await f.controller.reconcile();
    assert.deepEqual(f.commits[1], f.commits[0]);
    assert.deepEqual(f.previousChecks, [f.commits[0]!.mutations.map(item => item.operationId)]);
    assert.equal(f.reads.length, 1, 'Previous-archive reconciliation does not load or write the selected replacement archive.');
    assert.match(f.controller.getSnapshot().notice!, /not applied to the newly selected archive/);
    assert.equal(f.controller.getSnapshot().pendingRecovery, null);
    assert.equal(f.controller.getSnapshot().pendingMutation, false);
  });
}

test('an ordinary in-flight commit is not exposed as unknown recovery or replayed by a premature check', async t => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ onCommit: async () => held }); t.after(() => f.controller.dispose());
  const mutation = f.controller.mutation('SetTitle', { threadId: crypto.randomUUID(), value: 'Pending acknowledgement' });
  const write = f.controller.commit([mutation]);
  assert.equal(f.controller.getSnapshot().pendingMutation, true);
  assert.equal(f.controller.getSnapshot().pendingRecovery, null);
  await f.controller.reconcile();
  assert.equal(f.commits.length, 1);
  release(); await write;
  assert.equal(f.controller.getSnapshot().pendingMutation, false);
});

test('navigation while the post-replay library refresh is held does not get overwritten', async t => {
  let release!: () => void, refreshing = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME', onLibrary: async read => {
    if (read === 2) { refreshing = true; await held; }
  } }); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  await f.controller.update('SetTitle', 'Pending title');
  const retry = f.controller.reconcile(); await until(() => refreshing);
  const destination = crypto.randomUUID(), leaf = crypto.randomUUID();
  const next = f.controller.open(destination, leaf); f.complete(1); await next;
  release(); await retry;
  assert.equal(f.reads.length, 2);
  assert.equal(f.controller.getSnapshot().thread!.thread.id, destination);
  assert.equal(f.controller.getSnapshot().leaf, leaf);
  assert.equal(f.controller.getSnapshot().pendingRecovery, null);
});

test('a failed post-replay read does not turn an acknowledged commit back into unknown recovery', async t => {
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME', onLibrary: async read => {
    if (read === 2) throw new Error('Synthetic refresh failure after acknowledgement.');
  } }); t.after(() => f.controller.dispose());
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  await f.controller.update('SetTitle', 'Pending title');
  await f.controller.reconcile();
  assert.equal(f.controller.getSnapshot().pendingRecovery, null);
  assert.equal(f.controller.getSnapshot().pendingMutation, false);
  assert.match(f.controller.getSnapshot().error!, /refresh failure/);
  await f.controller.reconcile(); assert.equal(f.commits.length, 2);
});

test('disposal before a queued retry prevents dispatch and later publications', async () => {
  const f = fixture({ commitFailure: 'UNKNOWN_OUTCOME' });
  await f.controller.initialize();
  const opened = f.controller.open(crypto.randomUUID()); f.complete(0); await opened;
  await f.controller.update('SetTitle', 'Pending title');
  const retry = f.controller.reconcile();
  await f.controller.dispose();
  const snapshot = f.controller.getSnapshot();
  await retry;
  assert.equal(f.commits.length, 1);
  assert.equal(f.controller.getSnapshot(), snapshot);
});
