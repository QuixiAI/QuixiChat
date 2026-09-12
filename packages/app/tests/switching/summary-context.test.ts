import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorageClient, ThreadView } from '@quixi/core/contracts';
import { ATTACHMENT_EXCLUSION_MARKER, SUMMARY_LABEL } from '@quixi/core/model';
import type { ContentPart, ContextSnapshot, Message } from '@quixi/core/model';
import type { ProviderAdapter, ProviderInput } from '@quixi/providers';
import type { AppServices, ConfiguredProvider, LibraryController, LibrarySnapshot } from '../../src/runtime/library.ts';
import { createChatController } from '../../src/workflows/chat.ts';

const id = () => crypto.randomUUID();
function fixture(options: { boundary?: boolean; emptyLeaf?: boolean; tailSize?: number } = {}) {
  const threadId = id(), cutoff = id(), covered = id(), leaf = id(), excludedPartId = id();
  const message = (messageId: string, parentId: string | null, role: Message['role'] = 'user'): Message => ({
    id: messageId, threadId, parentId, role, createdAt: 1, recordedAt: 1,
    generationId: null, editedFromMessageId: null, partCount: 1, sealed: true,
  });
  const last = message(leaf, cutoff);
  const snapshot: ContextSnapshot = {
    id: id(), threadId, previousId: id(), version: 2, recordedAt: 2,
    systemPrompt: 'Current system remains authoritative.', preferredRoute: null,
    compaction: { version: 2, excludedPartIds: [excludedPartId], summary: {
      proposalId: id(), throughMessageId: cutoff, reviewedText: 'Reviewed decision: preserve identifier Q-17.', reviewedTextSha256: 'a'.repeat(64),
    } },
  };
  const thread = { thread: { id: threadId }, state: { revision: 4 }, context: snapshot } as ThreadView;
  let state = { thread, leaf: options.emptyLeaf ? null : leaf } as LibrarySnapshot;
  const reads: { operation: string; args: any }[] = [], inputs: ProviderInput[] = [];
  const storage = { async request(_requestId: string, operation: string, args: any) {
    reads.push({ operation, args });
    if (operation === 'readThreadView') return thread;
    if (operation === 'readConversationWindow') {
      if (options.tailSize) return { items: Array.from({ length: options.tailSize }, () => message(id(), cutoff)), nextCursor: 'too-large' };
      if (!args.page.cursor) return { items: [last], nextCursor: 'older' };
      return { items: options.boundary === false ? [message(covered, null)] : [message(covered, null), message(cutoff, covered, 'assistant')], nextCursor: 'unread-prefix' };
    }
    if (operation === 'readMessageParts') {
      assert.equal(args.messageId, leaf, 'covered message parts must never be read');
      const parts: ContentPart[] = [
        { id: id(), messageId: leaf, order: 0, kind: 'Text', data: { text: 'Retained user turn.' } },
        { id: excludedPartId, messageId: leaf, order: 1, kind: 'Image', data: { attachmentId: id(), description: 'Excluded private filename.png' } },
      ];
      return { items: parts, nextCursor: null };
    }
    throw new Error(`Forbidden request ${operation}; no covered or excluded attachment bytes may be read.`);
  } } as unknown as StorageClient;
  // A missing cutoff ends the metadata scan so refusal must happen before parts.
  if (options.boundary === false) {
    const request = storage.request.bind(storage);
    storage.request = (async (...args: any[]) => {
      const result: any = await (request as any)(...args);
      if (args[1] === 'readConversationWindow' && args[2].page.cursor) result.nextCursor = null;
      return result;
    }) as StorageClient['request'];
  }
  const adapter = {
    analyze(input: ProviderInput) { inputs.push(input); return { sendable: true }; },
    async countTokens(input: ProviderInput) { inputs.push(input); return { tokens: 10, source: 'provider', reason: null }; },
    prepare(input: ProviderInput) { inputs.push(input); throw new Error('Captured request before any generation or write.'); },
  } as unknown as ProviderAdapter;
  const provider: ConfiguredProvider = { id: 'synthetic', label: 'Synthetic', adapter, models: [] };
  const library = {
    getSnapshot: () => state,
    patch(patch: Partial<LibrarySnapshot>) { state = { ...state, ...patch }; },
    async commit() { assert.fail('These context checks must not write.'); },
  } as unknown as LibraryController;
  const controller = createChatController(library, { storage } as AppServices);
  return { controller, library, provider, snapshot, last, cutoff, reads, inputs };
}
function assertEffective(input: ProviderInput, draft = false) {
  assert.equal(input.systemPrompt, 'Current system remains authoritative.');
  assert.deepEqual(input.messages.map(message => ({ role: message.role, parts: message.parts.map(part => part.data) })), [
    { role: 'user', parts: [{ text: SUMMARY_LABEL + 'Reviewed decision: preserve identifier Q-17.' }] },
    { role: 'user', parts: [{ text: 'Retained user turn.' }, { text: ATTACHMENT_EXCLUSION_MARKER }] },
    ...(draft ? [{ role: 'user', parts: [{ text: 'New draft.' }] }] : []),
  ]);
  assert.equal(input.attachments, undefined);
}

test('summary inspection stops metadata paging at the cutoff and never reads covered parts or excluded bytes', async () => {
  const f = fixture(), inspection = await f.controller.inspectSwitch(f.provider, 'model');
  assertEffective(f.inputs[0]!);
  assert.equal(inspection?.transformed.reviewedSummary, true);
  assert.equal(inspection?.transformed.excludedAttachments, 1);
  assert.equal(f.reads.filter(read => read.operation === 'readConversationWindow').length, 2);
  assert.equal(f.reads.filter(read => read.operation === 'readMessageParts').length, 1);
});

test('count, send preparation and regeneration use the same reviewed summary and retained tail', async () => {
  for (const action of ['count', 'send', 'regenerate'] as const) {
    const f = fixture();
    if (action === 'count') await f.controller.countPrompt('New draft.', f.provider, 'model');
    if (action === 'send') assert.equal(await f.controller.send('New draft.', f.provider, 'model'), false);
    if (action === 'regenerate') await f.controller.regenerate(f.last, f.provider, 'model');
    assert.equal(f.inputs.length, 1, action);
    assertEffective(f.inputs[0]!, action !== 'regenerate');
    assert(f.reads.every(read => !['readBlobTransfer', 'readEntity'].includes(read.operation)));
  }
});

test('a divergent or earlier branch is refused before parts, provider calls or writes', async () => {
  for (const action of ['inspect', 'count', 'send', 'regenerate'] as const) {
    const f = fixture({ boundary: false });
    if (action === 'inspect') await assert.rejects(f.controller.inspectSwitch(f.provider, 'model'), /does not include the reviewed summary boundary/);
    if (action === 'count') await assert.rejects(f.controller.countPrompt('New draft.', f.provider, 'model'), /does not include the reviewed summary boundary/);
    if (action === 'send') assert.equal(await f.controller.send('New draft.', f.provider, 'model'), false);
    if (action === 'regenerate') await f.controller.regenerate(f.last, f.provider, 'model');
    if (action === 'send' || action === 'regenerate') assert.match(f.library.getSnapshot().error!, /does not include the reviewed summary boundary/);
    assert.equal(f.inputs.length, 0);
    assert(f.reads.every(read => read.operation !== 'readMessageParts'));
  }
});

test('an empty branch cannot silently discard a selected summary and summary consumes message budget', async () => {
  const empty = fixture({ emptyLeaf: true });
  await assert.rejects(empty.controller.countPrompt('New draft.', empty.provider, 'model'), /does not include the reviewed summary boundary/);
  const bounded = fixture({ tailSize: 2047 });
  await assert.rejects(bounded.controller.inspectSwitch(bounded.provider, 'model'), /request message limit/);
  assert(bounded.reads.every(read => read.operation !== 'readMessageParts'));
});

test('busy or uncertain canonical changes refuse prompt counting before any source read or provider call', async () => {
  for (const change of [{ busy: true }, { pendingMutation: true }]) {
    const f = fixture(); f.library.patch(change);
    assert.equal(await f.controller.countPrompt('New draft.', f.provider, 'model'), null);
    assert.deepEqual(f.reads, []); assert.deepEqual(f.inputs, []);
  }
});

test('a branch change or uncertain write during context preparation prevents late count dispatch', async () => {
  for (const change of ['leaf', 'revision', 'context', 'pending'] as const) {
    const f = fixture(), counting = f.controller.countPrompt('New draft.', f.provider, 'model');
    const thread = f.library.getSnapshot().thread!;
    if (change === 'leaf') f.library.patch({ leaf: null });
    if (change === 'pending') f.library.patch({ pendingMutation: true });
    if (change === 'revision') f.library.patch({ thread: { ...thread, state: { ...thread.state, revision: thread.state.revision + 1 } } });
    if (change === 'context') f.library.patch({ thread: { ...thread, context: { ...thread.context, id: id() } } });
    assert.equal(await counting, null); assert.deepEqual(f.inputs, []);
  }
});

test('a fresh empty branch counts only its current system prompt and new draft without reading old context', async () => {
  const f = fixture({ emptyLeaf: true });
  f.snapshot.compaction = { version: 2, excludedPartIds: f.snapshot.compaction!.excludedPartIds, summary: null };
  const result = await f.controller.countPrompt('New draft.', f.provider, 'model');
  assert.equal(result?.tokens, 10);
  assert.deepEqual(f.reads.map(read => read.operation), ['readThreadView'], 'only current policy metadata is rechecked; no old message or attachment reads');
  assert.equal(f.inputs[0]!.systemPrompt, f.snapshot.systemPrompt);
  assert.deepEqual(f.inputs[0]!.messages.map(message => ({ role: message.role, parts: message.parts.map(part => part.data) })), [
    { role: 'user', parts: [{ text: 'New draft.' }] },
  ]);
});
