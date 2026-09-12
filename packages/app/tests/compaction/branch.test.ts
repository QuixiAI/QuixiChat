import test from 'node:test';
import assert from 'node:assert/strict';
import type { MutationBatch, StorageClient, ThreadView } from '@quixi/core/contracts';
import type { AppServices, FreshBranchScope } from '../../src/runtime/library.ts';
import { createLibraryController } from '../../src/runtime/library.ts';
import { describeThreadEvent } from '../../src/runtime/events.ts';
import { digest, id, sourceFixture } from './fixtures.ts';

function fixture(lostReply = false) {
  const f = sourceFixture(), empty = { items: [], nextCursor: null, bytes: 2 };
  f.context.compaction = { version: 2, excludedPartIds: [id()], summary: { proposalId: id(), throughMessageId: f.root.id, reviewedText: 'Reviewed', reviewedTextSha256: digest('Reviewed') } };
  let view = { thread: { id: f.threadId }, state: { revision: 4, activeLeafMessageId: f.tail.id }, context: f.context } as ThreadView;
  const batches: MutationBatch[] = [], windows: (string | null)[] = [], operations: string[] = [];
  let selectionListener: (() => void) | undefined;
  const storage = { async request(_id: string, operation: string, args: any) {
    operations.push(operation);
    if (operation === 'commit') {
      batches.push(args);
      if (batches.length === 1) {
        const context = args.mutations.find((item: any) => item.kind === 'CreateContextSnapshot').payload.context;
        view = { ...view, context, state: { ...view.state, revision: 6, activeLeafMessageId: null } };
        if (lostReply) throw Object.assign(new Error('Lost commit reply'), { code: 'UNKNOWN_OUTCOME' });
      }
      return { committed: true };
    }
    if (operation === 'readThreadView') return view;
    if (operation === 'readConversationWindow') { windows.push(args.leafMessageId); assert.equal(args.leafMessageId, null); return empty; }
    if (operation === 'readMessageChildren') { assert.equal(args.parentMessageId, null); return { ...empty, items: [f.root] }; }
    if (operation === 'listLibrary' || operation === 'readEntities') return empty;
    assert.fail(`Unexpected operation ${operation}`);
  } } as unknown as StorageClient;
  const library = createLibraryController({ archiveId: id(), storage, archiveSession: { onSelectionChange(listener: () => void) { selectionListener = listener; return () => { selectionListener = undefined; }; } } } as unknown as AppServices);
  library.patch({ thread: view, leaf: f.tail.id, loading: false });
  const scope: FreshBranchScope = { threadId: f.threadId, revision: 4, contextId: f.context.id, leaf: f.tail.id };
  return { ...f, library, scope, batches, windows, operations, changeArchive: () => selectionListener?.() };
}

test('fresh branch retains its context choices, clears applied summary atomically, and reads no historical parts', async () => {
  const f = fixture(), before = structuredClone(f.context);
  await f.library.startContextBranch(f.scope);
  assert.equal(f.library.getSnapshot().error, null);
  const batch = f.batches[0]!;
  assert.deepEqual(batch.expectedThreadRevisions, [{ threadId: f.threadId, revision: 4 }]);
  assert.deepEqual(batch.stagedBlobIds, []);
  assert.deepEqual(batch.mutations.map(item => item.kind), ['CreateContextSnapshot', 'SetActiveBranch', 'CreateThreadEvent', 'CreateThreadEvent']);
  const context = f.library.getSnapshot().thread!.context;
  assert.equal(context.systemPrompt, before.systemPrompt);
  assert.deepEqual(context.compaction, { ...before.compaction, summary: null });
  assert.equal(context.previousId, before.id);
  assert.deepEqual(f.context, before, 'the original immutable context remains untouched');
  assert.equal(f.library.getSnapshot().leaf, null);
  assert.deepEqual(f.windows, [null]);
  const descriptions = batch.mutations.filter(item => item.kind === 'CreateThreadEvent').map(item => describeThreadEvent(item.payload.event));
  assert.match(descriptions[0]!, /Fresh branch started/);
  assert.match(descriptions[1]!, /Summary cleared for fresh branch/);
  assert(!descriptions.join(' ').includes('full history restored to requests'));
  await f.library.dispose();
});

test('lost branch reply replays the exact batch and reloads its null selection instead of the stale displayed leaf', async () => {
  const f = fixture(true);
  await f.library.startContextBranch(f.scope);
  assert.equal(f.library.getSnapshot().pendingMutation, true);
  assert.equal(f.library.getSnapshot().busy, false);
  assert.equal(f.library.getSnapshot().leaf, f.tail.id);
  const saved = structuredClone(f.batches[0]);
  await f.library.startContextBranch(f.scope);
  assert.equal(f.batches.length, 1);
  await f.library.reconcile();
  assert.strictEqual(f.batches[1], f.batches[0]);
  assert.deepEqual(f.batches[1], saved);
  assert.equal(f.library.getSnapshot().leaf, null);
  assert.deepEqual(f.windows, [null]);
  assert.equal(f.library.getSnapshot().pendingMutation, false);
  assert.equal(f.library.getSnapshot().error, null);
  await f.library.dispose();
});

test('stale review, empty or unselected leaf, busy work, and archive changes refuse branch writes', async () => {
  for (const change of ['revision', 'context', 'thread', 'empty', 'unselected', 'busy', 'archive'] as const) {
    const f = fixture(), scope = { ...f.scope };
    if (change === 'revision') scope.revision++;
    if (change === 'context') scope.contextId = id();
    if (change === 'thread') scope.threadId = id();
    if (change === 'empty') { scope.leaf = ''; f.library.patch({ leaf: null }); }
    if (change === 'unselected') { scope.leaf = f.root.id; f.library.patch({ leaf: f.root.id }); }
    if (change === 'busy') f.library.patch({ busy: true });
    if (change === 'archive') f.changeArchive();
    await f.library.startContextBranch(scope);
    assert.match(f.library.getSnapshot().error!, /conversation changed/);
    assert.deepEqual(f.operations, []);
    await f.library.dispose();
  }
});
