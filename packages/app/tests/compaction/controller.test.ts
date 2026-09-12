import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalMutation, MutationBatch, StorageClient, ThreadView } from '@quixi/core/contracts';
import type { ContentPart, Message, SummaryProposal } from '@quixi/core/model';
import { openAIRegionalEvidence } from '@quixi/providers';
import type { CompatibilityReport, ProviderAdapter, ProviderInput } from '@quixi/providers';
import type { AppServices, ConfiguredProvider, LibraryController, LibrarySnapshot } from '../../src/runtime/library.ts';
import { createLibraryController } from '../../src/runtime/library.ts';
import { createSummaryController } from '../../src/features/compaction/summaries.ts';
import { digest, id, sourceFixture } from './fixtures.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options: { archiveSession?: AppServices['archiveSession']; staging?: boolean } = {}) {
  const f = sourceFixture(), output = { ...f.message(id(), f.root.id), role: 'assistant' as const }, generation = f.generation(output.id);
  output.generationId = generation.id;
  const outputPart: ContentPart = { id: id(), messageId: output.id, order: 0, kind: 'Text', data: { text: 'Generated proposal keeps Q-17 unresolved.' } };
  const proposal: SummaryProposal = { version: 1, id: id(), threadId: f.threadId, recordedAt: 2, generationId: generation.id, sourceContextSnapshotId: f.context.id, requestContextSnapshotId: generation.contextSnapshotId, throughMessageId: f.root.id, sourceLeafMessageId: f.tail.id, sourceThreadRevision: 4, baseSummaryProposalId: null, baseSummaryContextId: null, ...f.info(), inputRawObjectId: id(), inputSha256: digest('{}'), inputByteLength: 2, promptTemplateVersion: 1 };
  const thread = { thread: { id: f.threadId }, state: { revision: 4, activeLeafMessageId: f.tail.id }, context: f.context } as ThreadView;
  let remoteThread = thread;
  let state = { thread, leaf: f.tail.id, busy: false, pendingMutation: false } as LibrarySnapshot;
  const calls: string[] = [], commits: { mutations: CanonicalMutation[]; expected: unknown }[] = [];
  let windowOverride: { items: Message[]; nextCursor: string | null } | null = null;
  let beforeRequest: (operation: string) => Promise<void> = async () => {}, countHook = async () => {};
  const storage = { async request(_id: string, operation: string, args: any) {
    calls.push(operation); await beforeRequest(operation);
    if (operation === 'readConversationWindow' && windowOverride) { assert.equal(args.page.cursor, null, 'covered history must not be paged'); return windowOverride; }
    if (operation === 'readConversationWindow') return { items: args.leafMessageId === f.root.id ? [f.root] : [f.root, f.tail], nextCursor: null };
    if (operation === 'readMessageParts') return { items: args.messageId === output.id ? [outputPart] : [f.part], nextCursor: null };
    if (operation === 'readSummarySourceInfo') return f.info();
    if (operation === 'readThreadView') return remoteThread;
    if (operation === 'readEntities') return { items: [proposal], nextCursor: null };
    if (operation === 'readEntity') return args.collection === 'generations' ? generation : output;
    if (operation === 'beginBlobTransfer') { if (options.staging) return { transferId: id(), maxChunkBytes: 65536 }; throw new Error('Summary staging boundary reached'); }
    if (options.staging && (operation === 'finishBlobTransfer' || operation === 'discardBlobTransfer')) return {};
    assert.fail(`Unexpected storage operation ${operation}`);
  }, async sendChunk() { calls.push('sendChunk'); }, async cancel() { calls.push('cancel'); } } as unknown as StorageClient;
  const report: CompatibilityReport = { target: { protocol: 'anthropic', modelId: 'synthetic' }, preserved: { parts: 2, byKind: { Text: 2 } }, blocked: [], constraints: [], requestBytes: 100, sendable: true, context: { contextWindow: 8192, maxOutputTokens: 1024, inputRoom: 7168 }, pricing: null };
  const adapter = { analyze() { calls.push('analyze'); return report; }, prepare(input: ProviderInput) { calls.push('prepare'); return { body: { model: input.modelId, messages: input.messages, system: input.systemPrompt } }; }, async countTokens() { calls.push('countTokens'); await countHook(); return { tokens: 10, source: 'provider', reason: null }; } } as unknown as ProviderAdapter;
  const provider: ConfiguredProvider = { id: 'synthetic', label: 'Synthetic', models: [], adapter };
  const library = { getSnapshot: () => state, patch(change: Partial<LibrarySnapshot>) { state = { ...state, ...change }; }, mutation(kind: CanonicalMutation['kind'], payload: unknown) { return { version: 1, operationId: id(), kind, payload, recordedAt: 3 }; }, async commit(mutations: CanonicalMutation[], expected: unknown) { commits.push({ mutations, expected }); }, async loadView() { calls.push('loadView'); } } as unknown as LibraryController;
  const controller = createSummaryController(library, { storage, archiveId: options.archiveSession?.selection.archiveId ?? id(), ...(options.archiveSession ? { archiveSession: options.archiveSession } : {}) } as AppServices);
  return { ...f, controller, library, proposal, provider, generation, output, outputPart, calls, commits, report, storage, thread,
    window(items: Message[], nextCursor: string | null) { windowOverride = { items, nextCursor }; },
    gate(operation: string, promise: Promise<void>) { beforeRequest = async op => { if (op === operation) await promise; }; },
    onCount(hook: () => Promise<void>) { countHook = hook; },
    beforeStorage(hook: (operation: string) => Promise<void>) { beforeRequest = hook; },
    remote(view: ThreadView) { remoteThread = view; },
    changeRevision() { state = { ...state, thread: { ...thread, state: { ...thread.state, revision: 5 } } }; },
  };
}
async function prepared(f: ReturnType<typeof fixture>, modelId = 'synthetic') { await f.controller.open(); await f.controller.prepare(f.root.id, f.provider, modelId, { maxOutputTokens: 1024 }); assert.equal(f.controller.getSnapshot().error, null); assert(f.controller.getSnapshot().prepared); }

test('preparing only constructs a request; explicit request review is required for count and generation', async () => {
  const f = fixture(); await prepared(f);
  assert.equal(f.calls.filter(call => call === 'countTokens').length, 0); assert.equal(f.commits.length, 0);
  const request = f.controller.getSnapshot().prepared!;
  assert.equal(request.sha256, digest(request.body)); assert.deepEqual(request.info, f.info());
  await f.controller.count(); assert.match(f.controller.getSnapshot().error!, /Review the provider request before counting/);
  await f.controller.generate(); assert.match(f.controller.getSnapshot().error!, /Review the provider request before generating/);
  assert.equal(f.calls.filter(call => call === 'countTokens').length, 0);
  f.controller.reviewRequest(true); await f.controller.count(); assert.equal(f.controller.getSnapshot().count?.tokens, 10); assert.equal(f.commits.length, 0);
});

test('cancelled discovery cancels its pending read and publishes no late candidates', async () => {
  const f = fixture(), gate = deferred(); f.gate('readConversationWindow', gate.promise);
  const opening = f.controller.open(); const cancelling = f.controller.cancel(); gate.resolve(); await Promise.all([opening, cancelling]);
  assert(f.calls.includes('cancel')); assert.deepEqual(f.controller.getSnapshot().candidates, []); assert.equal(f.controller.getSnapshot().busy, false); assert.equal(f.library.getSnapshot().busy, false);
});

test('target invalidation during prepare cannot publish an old target request', async () => {
  const f = fixture(); await f.controller.open(); const gate = deferred();
  f.gate('readSummarySourceInfo', gate.promise.then(() => {}));
  // A microtask loop only waits for this deterministic in-memory read to start.
  const preparing = f.controller.prepare(f.root.id, f.provider, 'old-model', { maxOutputTokens: 1024 });
  for (let i = 0; i < 20 && !f.calls.includes('readSummarySourceInfo'); i++) await Promise.resolve();
  assert(f.calls.includes('readSummarySourceInfo')); f.controller.invalidateTarget(); gate.resolve(); await preparing;
  assert.equal(f.controller.getSnapshot().prepared, null); assert.equal(f.controller.getSnapshot().requestReviewed, false); assert.equal(f.calls.includes('analyze'), false);
});

test('a stale selected revision refuses count and apply before provider calls or writes', async () => {
  const f = fixture(); await prepared(f); f.controller.reviewRequest(true); f.changeRevision(); await f.controller.count();
  assert.match(f.controller.getSnapshot().error!, /conversation changed/); assert.equal(f.calls.includes('countTokens'), false);
  await f.controller.select(f.proposal); f.controller.reviewText(true); await f.controller.apply();
  assert.match(f.controller.getSnapshot().error!, /conversation changed/); assert.equal(f.commits.length, 0);
});

test('late token counts are discarded when the selected revision changes during the provider request', async () => {
  const f = fixture(); await prepared(f); f.controller.reviewRequest(true);
  f.onCount(async () => { f.changeRevision(); }); await f.controller.count();
  assert.equal(f.controller.getSnapshot().count, null); assert.match(f.controller.getSnapshot().error!, /conversation changed/);
});

const summaryPricing: NonNullable<CompatibilityReport['pricing']> = { currency: 'USD', inputPerMillion: '1', outputPerMillion: '2', cachedInputPerMillion: null, cacheWriteInputPerMillion: null, sourceUrl: 'https://example.test/synthetic-pricing', verifiedAt: 1 };
const costProfile = (requirements: Record<string, string>) => ({ version: 4, alias: null, primary: { provider: 'synthetic', model: 'synthetic' }, candidates: [], requirements, allowPrivacyChange: false });

test('summary request cost blocks before freezing or writes, then explicit scoped counting unlocks the estimate', async () => {
  const f = fixture(); f.thread.state.routingProfile = costProfile({ maxEstimatedRequestCost: '0.003' }); f.report.pricing = summaryPricing;
  await prepared(f); f.controller.reviewRequest(true); f.calls.length = 0;
  assert.deepEqual(f.controller.costDecision(), { allowed: false, reason: 'Conservative context bound (8192 input tokens): estimated input plus maximum output cost 0.01024 USD exceeds the 0.003 USD per-attempt limit', inputAmount: '0.008192', totalAmount: '0.01024', basis: 'context_bound' });
  await f.controller.generate();
  assert.match(f.controller.getSnapshot().error!, /per-attempt limit/);
  assert.deepEqual(f.calls, []); assert.equal(f.commits.length, 0);
  await f.controller.count();
  assert.deepEqual(f.calls, ['countTokens', 'readThreadView', 'prepare']); assert.equal(f.commits.length, 0);
  const decision = f.controller.costDecision(); assert.equal(decision.allowed, true); assert.equal(decision.basis, 'counted'); assert.equal(decision.totalAmount, '0.002058');
  await f.controller.generate();
  assert.deepEqual(f.calls, ['countTokens', 'readThreadView', 'prepare', 'prepare', 'beginBlobTransfer']);
  assert.equal(f.controller.getSnapshot().error, 'Summary staging boundary reached');
  assert.equal(f.commits.length, 0, 'the test stops at the first staging operation, before generation persistence or dispatch');
});

test('summary checks retain the legacy input cap alongside the total cap and reject unknown pricing', async () => {
  for (const unknownPricing of [false, true]) {
    const f = fixture(); f.thread.state.routingProfile = costProfile({ maxRequestCost: '0.000005', maxEstimatedRequestCost: '0.003' });
    if (!unknownPricing) f.report.pricing = summaryPricing;
    await prepared(f); f.controller.reviewRequest(true); await f.controller.count(); f.calls.length = 0;
    const decision = f.controller.costDecision(); assert.equal(decision.allowed, false);
    assert.match(decision.reason, unknownPricing ? /pricing is required/ : /input limit/);
    await f.controller.generate(); assert.deepEqual(f.calls, []); assert.equal(f.commits.length, 0);
  }
});

test('summary cost decisions refuse unknown routing and stale scopes, while absent caps preserve uncounted generation', async () => {
  for (const mode of ['unknown', 'stale', 'no-cap'] as const) {
    const f = fixture(); await prepared(f); f.controller.reviewRequest(true); f.calls.length = 0;
    if (mode === 'unknown') f.thread.state.routingProfile = { version: 999 };
    if (mode === 'stale') f.changeRevision();
    assert.equal(f.controller.costDecision().allowed, mode === 'no-cap');
    await f.controller.generate();
    if (mode === 'no-cap') {
      assert.deepEqual(f.calls, ['prepare', 'beginBlobTransfer']); assert.equal(f.controller.getSnapshot().error, 'Summary staging boundary reached');
    } else {
      assert.deepEqual(f.calls, []); assert.match(f.controller.getSnapshot().error!, mode === 'unknown' ? /routing profile is unsupported/ : /conversation changed/);
    }
    assert.equal(f.commits.length, 0);
  }
});

test('edited text invalidates review and UTF-8 bytes enforce the 16 KiB apply bound', async () => {
  const f = fixture(); await f.controller.select(f.proposal);
  await f.controller.apply(); assert.equal(f.commits.length, 0);
  f.controller.reviewText(true); f.controller.edit('😀'.repeat(4097)); assert.equal(f.controller.getSnapshot().textReviewed, false);
  f.controller.reviewText(true); await f.controller.apply(); assert.equal(f.commits.length, 0); assert.match(f.controller.getSnapshot().error!, /16 KiB/);
  f.controller.edit('😀'.repeat(4096)); f.controller.reviewText(true); await f.controller.apply();
  assert.equal(f.controller.getSnapshot().error, null); assert.equal(f.commits.length, 1);
  const commit = f.commits[0]!; assert.deepEqual(commit.expected, { threadId: f.threadId, revision: 4 });
  assert.deepEqual(commit.mutations.map(mutation => mutation.kind), ['CreateContextSnapshot', 'CreateThreadEvent']);
  const contextMutation = commit.mutations[0]!; assert.equal(contextMutation.kind, 'CreateContextSnapshot');
  if (contextMutation.kind === 'CreateContextSnapshot') {
    const policy = contextMutation.payload.context.compaction; assert.equal(policy?.version, 2);
    if (policy?.version === 2) { assert.equal(policy.summary?.reviewedText, '😀'.repeat(4096)); assert.equal(policy.summary?.reviewedTextSha256, digest('😀'.repeat(4096))); }
  }
});

test('partial, stopped and non-text outputs remain inspectable but cannot be applied', async () => {
  for (const status of ['partial', 'stopped', 'complete'] as const) {
    const f = fixture(); f.generation.status = status;
    if (status === 'complete') Object.assign(f.outputPart, { kind: 'Note', data: { text: 'A note is not eligible summary output.' } });
    await f.controller.select(f.proposal); assert(f.controller.getSnapshot().selected?.refusal); f.controller.reviewText(true); await f.controller.apply(); assert.equal(f.commits.length, 0);
  }
});

test('apply detects changed source evidence despite unchanged thread revision', async () => {
  const f = fixture(); await f.controller.select(f.proposal); f.controller.reviewText(true);
  f.part.data = { text: 'Changed source evidence' }; await f.controller.apply();
  assert.match(f.controller.getSnapshot().error!, /source evidence changed/); assert.equal(f.commits.length, 0);
});


test('boundary discovery for a repeated summary stops at its prior cutoff before paging covered history', async () => {
  const f = fixture(), cutoff = id();
  f.root.parentId = cutoff;
  f.context.compaction = { version: 2, excludedPartIds: [], summary: { proposalId: id(), throughMessageId: cutoff, reviewedText: 'Previous reviewed summary', reviewedTextSha256: digest('Previous reviewed summary') } };
  f.window([f.message(cutoff, id()), f.root, f.tail], 'covered-history-may-be-arbitrarily-long');
  await f.controller.open();
  assert.equal(f.controller.getSnapshot().error, null);
  assert.deepEqual(f.controller.getSnapshot().candidates.map(message => message.id), [f.root.id]);
  assert.equal(f.calls.filter(call => call === 'readConversationWindow').length, 1);
});


test('an unknown apply outcome exposes the pending change globally and reconciles the exact batch without a new apply', async () => {
  const f = fixture(), batches: MutationBatch[] = [], snapshots: MutationBatch[] = [];
  const empty = { items: [], nextCursor: null, bytes: 2 };
  const storage = { ...f.storage, async request(requestId: string, operation: string, args: any) {
    if (operation === 'commit') {
      batches.push(args); snapshots.push(structuredClone(args));
      if (batches.length === 1) throw Object.assign(new Error('Reply was lost after dispatch'), { code: 'UNKNOWN_OUTCOME' });
      return { committed: true };
    }
    if (operation === 'listLibrary' || operation === 'readMessageChildren' || operation === 'readConversationWindow') return empty;
    if (operation === 'readThreadView') return f.thread;
    if (operation === 'readEntities' && args.collection === 'events') return empty;
    return (f.storage.request as any)(requestId, operation, args);
  } } as unknown as StorageClient;
  const services = { storage, archiveId: id() } as AppServices;
  const library = createLibraryController(services);
  library.patch({ thread: f.thread, leaf: f.tail.id, loading: false });
  const controller = createSummaryController(library, services);
  await controller.select(f.proposal); controller.reviewText(true); await controller.apply();
  assert.equal(batches.length, 1); assert.equal(library.getSnapshot().pendingMutation, true);
  assert.match(library.getSnapshot().error!, /unknown outcome.*Check the pending change/);
  assert.equal(controller.getSnapshot().busy, false); assert.equal(library.getSnapshot().busy, false);
  await controller.apply(); await controller.clear();
  assert.equal(batches.length, 1, 'a pending batch blocks fresh summary mutations');
  await library.reconcile();
  assert.equal(batches.length, 2); assert.strictEqual(batches[1], batches[0], 'reconciliation reuses the retained batch object');
  assert.deepEqual(snapshots[1], snapshots[0], 'transaction, mutation identities, text and review digest are unchanged');
  assert.deepEqual(snapshots[0]!.mutations.map(mutation => mutation.kind), ['CreateContextSnapshot', 'CreateThreadEvent']);
  assert.equal(library.getSnapshot().pendingMutation, false); assert.equal(library.getSnapshot().error, null);
  await controller.dispose(); await library.dispose();
});

test('the transcript loader refuses summary-purpose output and preserves the currently displayed conversation', async () => {
  const f = fixture();
  const storage = { ...f.storage, async request(requestId: string, operation: string, args: any) {
    if (operation === 'readThreadView') return f.thread;
    if (operation === 'readConversationWindow') return { items: [f.output], nextCursor: null, bytes: 100 };
    return (f.storage.request as any)(requestId, operation, args);
  } } as unknown as StorageClient;
  const library = createLibraryController({ storage, archiveId: id() } as AppServices);
  library.patch({ thread: f.thread, leaf: f.tail.id, messages: [{ message: f.root, generation: null, parts: [f.part], nextParts: null }] });
  await assert.rejects(library.loadView(f.threadId, f.output.id), /saved summary proposal.*Review conversation summaries/);
  assert.equal(library.getSnapshot().leaf, f.tail.id);
  assert.deepEqual(library.getSnapshot().messages.map(item => item.message.id), [f.root.id]);
  assert.equal(f.calls.includes('commit'), false);
  await library.dispose();
});


test('archive selection change discards late preparation or counting and unsubscribes when disposed', async () => {
  for (const action of ['prepare', 'count'] as const) {
    let selectionListener: ((selection: { archiveId: string; selectionRevision: number }) => void) | null = null;
    let unsubscribeCount = 0;
    const archiveSession = {
      selection: { archiveId: id(), selectionRevision: 1 },
      onSelectionChange(listener: NonNullable<typeof selectionListener>) {
        selectionListener = listener;
        return () => { unsubscribeCount++; selectionListener = null; };
      },
    } as AppServices['archiveSession'];
    const f = fixture({ archiveSession }), gate = deferred();
    let work: Promise<void>;
    if (action === 'prepare') {
      await f.controller.open(); f.gate('readSummarySourceInfo', gate.promise);
      work = f.controller.prepare(f.root.id, f.provider, 'synthetic', { maxOutputTokens: 1024 });
      for (let i = 0; i < 20 && !f.calls.includes('readSummarySourceInfo'); i++) await Promise.resolve();
      assert(f.calls.includes('readSummarySourceInfo'));
    } else {
      await prepared(f); f.controller.reviewRequest(true);
      f.onCount(() => gate.promise); work = f.controller.count();
      assert(f.calls.includes('countTokens'));
    }
    assert(selectionListener);
    (selectionListener as NonNullable<typeof selectionListener>)({ archiveId: id(), selectionRevision: 2 });
    gate.resolve(); await work;
    // Allow the selection listener's awaited task cleanup to publish after the task.
    await Promise.resolve();
    assert.equal(f.controller.getSnapshot().prepared, null);
    assert.equal(f.controller.getSnapshot().count, null);
    assert.equal(f.controller.getSnapshot().requestReviewed, false);
    assert.equal(f.library.getSnapshot().busy, false);
    if (action === 'prepare') assert(f.calls.includes('cancel'));
    const callsBefore = [...f.calls];
    f.controller.reviewRequest(true); await f.controller.generate();
    assert.deepEqual(f.calls, callsBefore, 'the invalidated controller cannot dispatch or stage a request');
    assert.equal(f.commits.length, 0);
    await f.controller.open(); assert.match(f.controller.getSnapshot().error!, /selected archive changed/);
    await f.controller.dispose();
    assert.equal(unsubscribeCount, 1); assert.equal(selectionListener, null);
  }
});


const regionalProfile = (processingRegion: 'us' | 'eu', other: Record<string,string> = {}) => ({ ...costProfile({...other, processingRegion}), version: 5 });
function configureRegional(f: ReturnType<typeof fixture>, region: 'us' | 'eu') {
  const evidence = openAIRegionalEvidence(region), modelId = evidence.modelIds[0]!;
  f.provider.regionalProcessing = evidence;
  Object.assign(f.provider.adapter, { binding: evidence.binding, protocol: 'openai-compatible', describeModel: (model: string) => model === modelId ? { id: model } : null });
  return modelId;
}

test('unknown or mismatched summary region blocks counting and staging independently of cost eligibility', async () => {
  for (const mismatch of [false,true]) {
    const f = fixture(); f.thread.state.routingProfile = regionalProfile('us');
    const modelId = mismatch ? configureRegional(f, 'eu') : 'synthetic';
    await prepared(f, modelId); f.controller.reviewRequest(true); f.calls.length = 0;
    assert.equal(f.controller.costDecision().allowed, true); assert.equal(f.controller.regionDecision().allowed, false);
    await f.controller.count(); assert.equal(f.controller.getSnapshot().count, null);
    assert.match(f.controller.getSnapshot().error!, mismatch ? /does not match required/ : /region is unknown/);
    await f.controller.generate(); assert.deepEqual(f.calls, []); assert.equal(f.commits.length, 0);
  }
});

test('reviewed regional binding allows explicit summary count while an independent cost cap blocks generation', async () => {
  const f = fixture(), modelId = configureRegional(f, 'us');
  f.thread.state.routingProfile = regionalProfile('us', { maxEstimatedRequestCost: '0.003' }); f.report.pricing = summaryPricing;
  await prepared(f, modelId); f.controller.reviewRequest(true); f.calls.length = 0;
  assert.equal(f.controller.regionDecision().allowed, true); assert.equal(f.controller.regionDecision().basis, openAIRegionalEvidence('us').configurationId);
  assert.equal(f.controller.costDecision().allowed, false); await f.controller.generate(); assert.deepEqual(f.calls, []);
  await f.controller.count(); assert.equal(f.controller.getSnapshot().count?.tokens, 10); assert.deepEqual(f.calls, ['countTokens','readThreadView','prepare']);
  assert.equal(f.controller.costDecision().allowed, true); await f.controller.generate(); assert.equal(f.calls.at(-1), 'beginBlobTransfer'); assert.equal(f.commits.length, 0);
});

test('regional evidence and routing profile changes during summary count cannot publish an old count', async () => {
  for (const change of ['evidence','profile','binding'] as const) {
    const f = fixture(), modelId = configureRegional(f, 'us'); f.thread.state.routingProfile = regionalProfile('us');
    await prepared(f, modelId); f.controller.reviewRequest(true); f.calls.length = 0;
    f.onCount(async () => {
      if (change === 'evidence') f.provider.regionalProcessing = openAIRegionalEvidence('eu');
      else if (change === 'profile') f.thread.state.routingProfile = regionalProfile('eu');
      else Object.assign(f.provider.adapter, { binding: openAIRegionalEvidence('eu').binding });
    });
    await f.controller.count(); assert.equal(f.controller.getSnapshot().count, null); assert.equal(f.controller.regionDecision().allowed, false);
    assert.match(f.controller.getSnapshot().error!, change === 'evidence' ? /evidence changed/ : change === 'profile' ? /conversation changed/ : /no matching reviewed/);
    assert.deepEqual(f.calls, ['countTokens']); await f.controller.generate(); assert.deepEqual(f.calls, ['countTokens']); assert.equal(f.commits.length, 0);
  }
});

test('evidence changed during local summary preparation never becomes a reviewed destination', async () => {
  const f = fixture(), modelId = configureRegional(f, 'us'); f.thread.state.routingProfile = regionalProfile('us');
  await f.controller.open(); const gate = deferred(); f.gate('readSummarySourceInfo', gate.promise);
  const preparing = f.controller.prepare(f.root.id, f.provider, modelId, { maxOutputTokens: 1024 });
  for(let i=0;i<20&&!f.calls.includes('readSummarySourceInfo');i++)await Promise.resolve();
  assert(f.calls.includes('readSummarySourceInfo')); f.provider.regionalProcessing = openAIRegionalEvidence('eu'); gate.resolve(); await preparing;
  assert.equal(f.controller.getSnapshot().prepared, null); assert.match(f.controller.getSnapshot().error!, /evidence changed/); assert.equal(f.calls.includes('countTokens'), false); assert.equal(f.commits.length, 0);
});

test('summary count rechecks current adapter eligibility and exact prepared body after awaiting the provider', async () => {
  for (const changed of ['eligibility','body'] as const) {
    const f = fixture(), modelId = configureRegional(f, 'us'); f.thread.state.routingProfile = regionalProfile('us');
    await prepared(f, modelId); f.controller.reviewRequest(true);
    f.onCount(async () => { f.provider.adapter.prepare = () => { if (changed === 'eligibility') throw new Error('Regional credential eligibility was revoked'); return { body: { changed: true } } as unknown as ReturnType<ProviderAdapter['prepare']>; }; });
    await f.controller.count(); assert.equal(f.controller.getSnapshot().count, null);
    assert.match(f.controller.getSnapshot().error!, changed === 'eligibility' ? /eligibility was revoked/ : /provider request changed/); assert.equal(f.calls.includes('beginBlobTransfer'), false); assert.equal(f.commits.length, 0);
  }
});


test('region or eligibility changes while staging prevent canonical publication and discard unused summary input', async () => {
  for (const change of ['evidence','profile','eligibility'] as const) {
    const f = fixture({ staging: true }), modelId = configureRegional(f, 'us'); f.thread.state.routingProfile = regionalProfile('us');
    await prepared(f, modelId); f.controller.reviewRequest(true); f.calls.length = 0;
    f.beforeStorage(async operation => {
      if (operation !== 'finishBlobTransfer') return;
      if (change === 'evidence') f.provider.regionalProcessing = openAIRegionalEvidence('eu');
      else if (change === 'profile') f.thread.state.routingProfile = regionalProfile('eu');
      else f.provider.adapter.prepare = () => { throw new Error('Regional credential eligibility was revoked'); };
    });
    await f.controller.generate(); assert(f.calls.includes('sendChunk')); assert(f.calls.includes('finishBlobTransfer')); assert.equal(f.calls.at(-1), 'discardBlobTransfer');
    assert.equal(f.commits.length, 0); assert.match(f.controller.getSnapshot().error!, change === 'evidence' ? /evidence changed/ : change === 'profile' ? /conversation changed/ : /eligibility was revoked/);
  }
});


test('summary count dispatch callback refuses a concurrently changed canonical policy before provider HTTP', async () => {
  for (const change of ['revision','profile','evidence'] as const) {
    const f = fixture(), modelId = configureRegional(f, 'us'); f.thread.state.routingProfile = regionalProfile('us');
    await prepared(f, modelId); f.controller.reviewRequest(true); f.calls.length = 0;
    f.provider.adapter.countTokens = async (_input, beforeDispatch) => {
      assert(beforeDispatch, 'count dispatch must carry the fresh canonical policy guard'); f.calls.push('countTokens');
      // Simulate another client's canonical commit after host request-body staging.
      if(change==='evidence')f.provider.regionalProcessing=openAIRegionalEvidence('eu');
      else f.remote({...f.thread,state:{...f.thread.state,...(change==='revision'?{revision:5}:{routingProfile:regionalProfile('eu')})}});
      await beforeDispatch(); f.calls.push('providerHttp'); return {tokens:10,source:'provider',reason:null};
    };
    await f.controller.count(); assert.equal(f.controller.getSnapshot().count,null); assert.equal(f.calls.includes('providerHttp'),false); assert.equal(f.commits.length,0);
    assert.match(f.controller.getSnapshot().error!,change==='evidence'?/evidence changed/:/conversation changed before provider dispatch/);
    assert.equal(f.library.getSnapshot().thread!.state.revision,4,'cached library selection alone would have allowed the old revision');
  }
});
