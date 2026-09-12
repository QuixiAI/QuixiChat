import { canonicalJson } from '@quixi/core/contracts';
import type { StorageOperations } from '@quixi/core/contracts';
import { contextSummary, SUMMARY_INSTRUCTION, SUMMARY_LIMITS, summaryOutputText, utf8ByteLength } from '@quixi/core/model';
import type { ContentPart, ContextSnapshot, Generation, Message, RawObject, SummaryProposal } from '@quixi/core/model';
import type { CompatibilityReport, GenerationRun, ProviderInput } from '@quixi/providers';
import type { AppServices, ConfiguredProvider, LibraryController } from '../../runtime/library.ts';
import { parseRoutingProfile } from '../../runtime/routing.ts';
import { assessProcessingRegion, processingRegionKey } from '../../runtime/processing-region.ts';
import { assessRequestCost } from '../../runtime/request-cost.ts';
import type { RequestCostAssessment } from '../../runtime/request-cost.ts';
import { startCoordinatedGeneration } from '../../workflows/generation.ts';
import { buildSummaryInput, collectSummarySource, readSummaryBytes, summaryHash } from './summary-source.ts';
const id = () => crypto.randomUUID();
type Scope = { threadId: string; revision: number; contextId: string; leaf: string; context: ContextSnapshot; routingKey: string };
type Prepared = { provider: ConfiguredProvider; regionKey: string; input: ProviderInput; body: string; sha256: string; info: StorageOperations['readSummarySourceInfo']['result']; scope: Scope; through: string; report: CompatibilityReport; omitted: number; textBytes: number; imageBytes: number };
type Selected = { proposal: SummaryProposal; generation: Generation; generated: string; refusal: string | null };
export function createSummaryController(library: LibraryController, services: AppServices) {
  let state = { open: false, busy: false, error: null as string | null, notice: null as string | null,
    candidates: [] as Message[], proposals: [] as SummaryProposal[], next: null as string | null,
    prepared: null as Prepared | null, requestReviewed: false, count: null as { tokens: number | null; reason: string | null } | null,
    selected: null as Selected | null, reviewedText: '', textReviewed: false, frozenInput: null as string | null };
  const listeners = new Set<() => void>();
  let epoch = 0, pending: string | null = null, run: GenerationRun | null = null, active: Promise<void> | null = null, disposed = false, selectionChanged = false;
  const patch = (change: Partial<typeof state>) => { if (disposed) return; state = { ...state, ...change }; for (const listener of listeners) listener(); };
  const scope = (): Scope => {
    if (selectionChanged) throw new Error('The selected archive changed. Open it before reviewing another summary.');
    const current = library.getSnapshot(), view = current.thread;
    if (!view || !current.leaf || current.leaf !== view.state.activeLeafMessageId) throw new Error('Select the active conversation branch before reviewing a summary.');
    return { threadId: view.thread.id, revision: view.state.revision, contextId: view.context.id, leaf: current.leaf, context: view.context, routingKey: canonicalJson(view.state.routingProfile ?? null) };
  };
  const same = (captured: Scope) => {
    const current = scope();
    if (current.routingKey !== captured.routingKey) {
      const source = library.getSnapshot().thread?.state.routingProfile ?? null;
      if (source !== null && !parseRoutingProfile(source)) throw new Error('The conversation routing profile is unsupported. Review and update it before generating a summary.');
    }
    if (current.threadId !== captured.threadId || current.revision !== captured.revision || current.contextId !== captured.contextId || current.leaf !== captured.leaf || current.routingKey !== captured.routingKey) throw new Error('The conversation changed. Prepare and review a fresh summary.');
  };
  const sameTarget = (captured: Scope, provider: ConfiguredProvider, regionKey: string) => {
    same(captured);
    if (processingRegionKey(provider) !== regionKey) throw new Error('The processing-region evidence changed. Prepare and review a fresh summary request.');
  };
  const regionDecision = (): ReturnType<typeof assessProcessingRegion> => {
    try {
      const prepared = state.prepared;
      if (!prepared) throw new Error('Prepare a summary request to review its processing region.');
      sameTarget(prepared.scope, prepared.provider, prepared.regionKey);
      const source = library.getSnapshot().thread?.state.routingProfile ?? null, profile = parseRoutingProfile(source);
      if (source !== null && !profile) throw new Error('The conversation routing profile is unsupported. Review and update it before generating a summary.');
      return assessProcessingRegion(profile?.requirements ?? {}, prepared.provider, prepared.input.modelId);
    } catch (error) { return { allowed: false, reason: error instanceof Error ? error.message : String(error), basis: null }; }
  };
  const requireRegion = (prepared: Prepared) => {
    sameTarget(prepared.scope, prepared.provider, prepared.regionKey);
    const decision = regionDecision();
    if (!decision.allowed) throw new Error(decision.reason);
    return decision;
  };
  const validatePreparedBody = (prepared: Prepared) => {
    if (JSON.stringify(prepared.provider.adapter.prepare(prepared.input).body) !== prepared.body) throw new Error('The provider request changed. Prepare and review it again.');
  };
  const costDecision = (): RequestCostAssessment => {
    try {
      const prepared = state.prepared;
      if (!prepared) throw new Error('Prepare a summary request to review its cost.');
      same(prepared.scope);
      const source = library.getSnapshot().thread?.state.routingProfile ?? null;
      const profile = parseRoutingProfile(source);
      if (source !== null && !profile) throw new Error('The conversation routing profile is unsupported. Review and update it before generating a summary.');
      return assessRequestCost({ requirements: profile?.requirements ?? {}, pricing: prepared.report.pricing,
        contextWindow: prepared.report.context.contextWindow, maxOutputTokens: prepared.input.parameters.maxOutputTokens,
        countedInputTokens: state.count?.tokens ?? null });
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error), inputAmount: null, totalAmount: null, basis: 'unavailable' };
    }
  };
  const beforeProviderDispatch = async (prepared: Prepared, request: import('./summary-source.ts').SummaryRequest, check: () => void) => {
    check(); requireRegion(prepared);
    const current = await request('readThreadView', { threadId: prepared.scope.threadId });
    check(); requireRegion(prepared);
    if (current.thread.id !== prepared.scope.threadId || current.state.revision !== prepared.scope.revision || current.context.id !== prepared.scope.contextId || current.state.activeLeafMessageId !== prepared.scope.leaf || canonicalJson(current.state.routingProfile ?? null) !== prepared.scope.routingKey) throw new Error('The conversation changed before provider dispatch. Prepare and review a fresh summary.');
    const source = current.state.routingProfile ?? null, profile = parseRoutingProfile(source);
    if (source !== null && !profile) throw new Error('The conversation routing profile is unsupported. Review and update it before generating a summary.');
    const regional = assessProcessingRegion(profile?.requirements ?? {}, prepared.provider, prepared.input.modelId);
    if (!regional.allowed) throw new Error(regional.reason);
    validatePreparedBody(prepared); check(); requireRegion(prepared);
  };
  const work = (task: (request: import('./summary-source.ts').SummaryRequest, check: () => void) => Promise<void>) => {
    if (state.busy || library.getSnapshot().busy || library.getSnapshot().pendingMutation || disposed) return Promise.resolve();
    const current = ++epoch; let requests = 0, bytes = 0;
    const check = () => { if (disposed || selectionChanged || epoch !== current) throw new Error('Summary operation cancelled'); };
    const request = async <K extends keyof StorageOperations>(operation: K, args: StorageOperations[K]['args']): Promise<StorageOperations[K]['result']> => {
      check(); if (++requests > 4096) throw new Error('Summary review exceeds its bounded request budget; choose a shorter branch.');
      const requestId = id(); pending = requestId;
      try { const result = await services.storage.request(requestId, operation, args); check(); bytes += utf8ByteLength(JSON.stringify(result)); if (bytes > 8 * 1024 * 1024) throw new Error('Summary review exceeds 8 MiB of metadata; choose a shorter branch.'); return result; }
      finally { if (pending === requestId) pending = null; }
    };
    patch({ busy: true, error: null, notice: null }); library.patch({ busy: true });
    const promise = task(request, check).catch(error => {
      if (library.getSnapshot().pendingMutation) library.patch({ error: 'The summary change has an unknown outcome. Check the pending change before continuing.' });
      if (current === epoch) patch({ error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (active === promise) { active = null; run = null; library.patch({ busy: false }); patch({ busy: false }); }
    }); active = promise; return promise;
  };
  const list = async (request: import('./summary-source.ts').SummaryRequest, threadId: string, cursor: string | null = null) => {
    const page = await request('readEntities', { collection: 'summaryProposals', threadId, page: { maxItems: 16, maxBytes: 65536, cursor } });
    patch({ proposals: page.items as unknown as SummaryProposal[], next: page.nextCursor });
  };
  const inspect = async (request: import('./summary-source.ts').SummaryRequest, proposal: SummaryProposal) => {
    const generation = await request('readEntity', { collection: 'generations', id: proposal.generationId }) as unknown as Generation | null;
    if (!generation) throw new Error('Summary generation is missing');
    const output = await request('readEntity', { collection: 'messages', id: generation.outputMessageId }) as unknown as Message | null;
    if (!output) throw new Error('Summary output is missing');
    const parts: ContentPart[] = []; let cursor: string | null = null;
    do { const page: StorageOperations['readMessageParts']['result'] = await request('readMessageParts', { messageId: output.id, page: { maxItems: 32, maxBytes: 65536, cursor } }); parts.push(...page.items as unknown as ContentPart[]); if (parts.length > SUMMARY_LIMITS.parts) throw new Error('Summary output exceeds the review part limit'); cursor = page.nextCursor; } while (cursor);
    let generated = '', refusal: string | null = null;
    try { generated = summaryOutputText(generation, output, parts); }
    catch (error) { refusal = error instanceof Error ? error.message : String(error); generated = parts.flatMap(part => part.kind === 'Text' && !part.data.textBlob ? [part.data.text] : []).join('').slice(0, SUMMARY_LIMITS.textBytes); }
    patch({ selected: { proposal, generation, generated, refusal }, reviewedText: generated, textReviewed: false, frozenInput: null });
  };
  const cancel = async () => { const cancelledEpoch = ++epoch; if (pending) await services.storage.cancel(pending, null).catch(() => {}); if (run) await run.cancel().catch(() => {}); await active; if (epoch !== cancelledEpoch) return; patch({ prepared: null, requestReviewed: false, textReviewed: false, notice: 'Summary operation stopped. Any saved proposal remains available under saved proposals.' }); };
  const unsubscribeSelection = services.archiveSession?.onSelectionChange(() => { selectionChanged = true; void cancel(); patch({ error: 'The selected archive changed. Open it before reviewing another summary.' }); });
  return {
    getSnapshot: () => state,
    costDecision,
    regionDecision,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel,
    reset() { void cancel(); patch({ open: false, candidates: [], proposals: [], next: null, prepared: null, selected: null, frozenInput: null, error: null }); },
    invalidateTarget() { if (state.busy) void cancel(); patch({ prepared: null, count: null, requestReviewed: false }); },
    async dispose() { disposed = true; unsubscribeSelection?.(); await cancel(); listeners.clear(); },
    reviewRequest(value: boolean) { patch({ requestReviewed: value }); },
    edit(value: string) { patch({ reviewedText: value, textReviewed: false }); },
    reviewText(value: boolean) { patch({ textReviewed: value }); },
    open() { patch({ open: true }); return work(async (request) => {
      const captured = scope(), messages: Message[] = [], base = contextSummary(captured.context); let cursor: string | null = null, foundBase = false;
      do { const page: StorageOperations['readConversationWindow']['result'] = await request('readConversationWindow', { threadId: captured.threadId, leafMessageId: captured.leaf, page: { maxItems: 64, maxBytes: 131072, cursor } });
        const boundary = base ? page.items.findIndex(message => message.id === base.throughMessageId) : -1;
        messages.unshift(...(boundary >= 0 ? page.items.slice(boundary) : page.items)); foundBase = boundary >= 0;
        if (messages.length - Number(foundBase) > SUMMARY_LIMITS.messages) throw new Error('Summary boundary review exceeds 2,047 messages. Choose a shorter branch.'); cursor = page.nextCursor;
      } while (cursor && !foundBase);
      const baseIndex = base ? messages.findIndex(message => message.id === base.throughMessageId) : -1;
      if (base && baseIndex < 0) throw new Error('The current summary boundary is outside this branch. Clear it before choosing another branch.');
      same(captured); patch({ candidates: messages.filter((message, index) => index > baseIndex && message.sealed && messages[index + 1]?.role === 'user') });
      await list(request, captured.threadId);
    }); },
    next() { return work(async request => { await list(request, scope().threadId, state.next); }); },
    select(proposal: SummaryProposal) { return work(async request => { if (proposal.threadId !== scope().threadId) throw new Error('Proposal belongs to another conversation'); await inspect(request, proposal); }); },
    prepare(through: string, provider: ConfiguredProvider, modelId: string, parameters: ProviderInput['parameters']) {
      patch({ prepared: null, requestReviewed: false, count: null });
      return work(async (request, check) => {
        if (!state.candidates.some(message => message.id === through)) throw new Error('Choose a cutoff before a retained user turn.');
        const captured = scope(), regionKey = processingRegionKey(provider), source = await collectSummarySource(request, captured.context, through);
        const info = await request('readSummarySourceInfo', { contextSnapshotId: captured.contextId, throughMessageId: through });
        if (await summaryHash(canonicalJson(source as never)) !== info.sourceFingerprint) throw new Error('Source changed during review. Prepare the proposal again.');
        const built = await buildSummaryInput(source, services.storage, request, modelId, parameters, () => { check(); sameTarget(captured, provider, regionKey); });
        check(); sameTarget(captured, provider, regionKey);
        const report = provider.adapter.analyze(built.input);
        if (!report.sendable) throw new Error([...report.blocked, ...report.constraints].map(item => item.message).join(' '));
        const body = JSON.stringify(provider.adapter.prepare(built.input).body);
        if (utf8ByteLength(body) > SUMMARY_LIMITS.inputBytes) throw new Error('Prepared summary request exceeds 4 MiB. Choose a smaller prefix.');
        const sha256 = await summaryHash(body); check(); sameTarget(captured, provider, regionKey);
        patch({ prepared: { provider, regionKey, input: built.input, body, sha256, info, scope: captured, through, report, omitted: built.omitted, textBytes: built.textBytes, imageBytes: built.imageBytes } });
      });
    },
    count() { return work(async (request, check) => {
      const prepared = state.prepared;
      if (!prepared || !state.requestReviewed) throw new Error('Review the provider request before counting.');
      patch({ count: null }); requireRegion(prepared);
      const result = await prepared.provider.adapter.countTokens(prepared.input, () => beforeProviderDispatch(prepared, request, check));
      check(); await beforeProviderDispatch(prepared, request, check); check(); requireRegion(prepared);
      patch({ count: result });
    }); },
    generate() { return work(async (request, check) => {
      const prepared = state.prepared;
      if (!prepared || !state.requestReviewed) throw new Error('Review the provider request before generating a proposal.');
      requireRegion(prepared);
      const cost = costDecision();
      if (!cost.allowed) throw new Error(cost.reason);
      if (state.count?.tokens !== null && state.count?.tokens !== undefined && prepared.report.context.inputRoom !== null && state.count.tokens > prepared.report.context.inputRoom) throw new Error('The counted summary input exceeds the model context room. Choose a smaller prefix.');
      // Re-map immediately before freezing. The transport uses this same immutable input.
      validatePreparedBody(prepared); check(); requireRegion(prepared);
      const bytes = new TextEncoder().encode(prepared.body), stage = await request('beginBlobTransfer', { operationId: id(), purpose: 'raw_source', expectedBytes: bytes.length, expectedSha256: prepared.sha256 });
      let published = false;
      try {
        for (let offset = 0, sequence = 0; offset < bytes.length; sequence++) { check(); requireRegion(prepared); const chunk = bytes.slice(offset, offset + Math.min(65536, stage.maxChunkBytes)); await services.storage.sendChunk({ transferId: stage.transferId, sequence, offset, bytes: chunk, final: offset + chunk.length === bytes.length }); offset += chunk.length; }
        await request('finishBlobTransfer', { operationId: id(), transferId: stage.transferId, expectedBytes: bytes.length, expectedSha256: prepared.sha256 });
        check(); requireRegion(prepared);
        const now = Date.now(), context: ContextSnapshot = { id: id(), threadId: prepared.scope.threadId, previousId: prepared.scope.contextId, version: prepared.scope.context.version + 1, systemPrompt: SUMMARY_INSTRUCTION, preferredRoute: null, recordedAt: now };
        const raw: RawObject = { id: id(), availability: 'available', sha256: prepared.sha256, byteLength: bytes.length, mediaType: 'application/vnd.quixi.summary-input+json', storageRef: `sha256:${prepared.sha256}` };
        validatePreparedBody(prepared); check(); requireRegion(prepared);
        await library.commit([library.mutation('RegisterRawObject', { rawObject: raw }), library.mutation('CreateContextSnapshot', { context, select: false })], { threadId: prepared.scope.threadId, revision: prepared.scope.revision }, [stage.transferId]); published = true;
        check(); const region = requireRegion(prepared);
        const generation: Generation = { purpose: 'context_summary', id: id(), threadId: prepared.scope.threadId, parentMessageId: prepared.through, outputMessageId: id(), contextSnapshotId: context.id, provider: prepared.provider.adapter.binding.providerId, providerAccountId: prepared.provider.adapter.binding.accountId, model: prepared.input.modelId, parameters: {}, status: 'streaming', createdAt: now, recordedAt: now, completedAt: null, tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null, reportedCost: null, lastSequence: 0, rawResponseId: null, compatibility: [`Summary processing-region check: ${region.reason}`] };
        const output: Message = { id: generation.outputMessageId, threadId: generation.threadId, parentId: prepared.through, role: 'assistant', createdAt: now, recordedAt: now, generationId: generation.id, editedFromMessageId: null, partCount: 0, sealed: false };
        const base = contextSummary(prepared.scope.context), proposal: SummaryProposal = { version: 1, id: id(), threadId: generation.threadId, recordedAt: now, generationId: generation.id, sourceContextSnapshotId: prepared.scope.contextId, requestContextSnapshotId: context.id, throughMessageId: prepared.through, sourceLeafMessageId: prepared.scope.leaf, sourceThreadRevision: prepared.scope.revision, baseSummaryProposalId: base?.proposalId ?? null, baseSummaryContextId: base ? prepared.scope.contextId : null, ...prepared.info, inputRawObjectId: raw.id, inputSha256: raw.sha256!, inputByteLength: bytes.length, promptTemplateVersion: 1 };
        run = await startCoordinatedGeneration({ archiveId: services.archiveId, initialThreadRevision: prepared.scope.revision, adapter: prepared.provider.adapter, input: prepared.input, storage: services.storage, beforeDispatch: () => beforeProviderDispatch(prepared, request, check), attempt: { generation, output }, nextId: id, now: Date.now,
          createWith: () => { check(); requireRegion(prepared); validatePreparedBody(prepared); check(); requireRegion(prepared); return [library.mutation('RegisterSummaryProposal', { proposal }), library.mutation('CreateThreadEvent', { event: { id: id(), threadId: generation.threadId, type: 'ContextCompaction', createdAt: now, recordedAt: now, messageId: prepared.through, generationId: generation.id, details: { action: 'summary_proposed', proposalId: proposal.id, sourceContextSnapshotId: proposal.sourceContextSnapshotId, inputSha256: proposal.inputSha256 } } })]; },
          onCreated: async () => { check(); requireRegion(prepared); },
        });
        try { check(); } catch (error) { await run.cancel(); throw error; }
        const result = await run.result; check();
        if (!result.persisted) throw new Error(result.error?.message ?? 'The proposal could not be fully saved. Reopen saved proposals to inspect its retained state.');
        await inspect(request, proposal); await list(request, proposal.threadId); await library.loadView(proposal.threadId, prepared.scope.leaf);
        patch({ prepared: null, requestReviewed: false, notice: 'Proposal saved. Review its claims against the source history before applying it.' });
      } finally { if (!published && !library.getSnapshot().pendingMutation) await services.storage.request(id(), 'discardBlobTransfer', { transferId: stage.transferId }).catch(() => {}); }
    }); },
    inspectInput() { return work(async (request, check) => { const proposal = state.selected?.proposal; if (!proposal) return; const bytes = await readSummaryBytes(services.storage, request, proposal.inputSha256, proposal.inputByteLength, SUMMARY_LIMITS.inputBytes, check); patch({ frozenInput: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }); }); },
    apply() { return work(async (request, check) => {
      const selected = state.selected, text = state.reviewedText;
      if (!selected || selected.refusal || !state.textReviewed || !text.trim() || utf8ByteLength(text) > SUMMARY_LIMITS.textBytes) throw new Error('Review a complete text proposal of at most 16 KiB before applying.');
      const captured = scope(), proposal = selected.proposal;
      if (captured.contextId !== proposal.sourceContextSnapshotId || captured.leaf !== proposal.sourceLeafMessageId || captured.revision !== proposal.sourceThreadRevision) throw new Error('The conversation changed after this proposal. Generate a fresh proposal.');
      const info = await request('readSummarySourceInfo', { contextSnapshotId: captured.contextId, throughMessageId: proposal.throughMessageId });
      if (info.sourceFingerprint !== proposal.sourceFingerprint) throw new Error('The source evidence changed. Generate a fresh proposal.');
      const digest = await summaryHash(text); check(); same(captured);
      const context: ContextSnapshot = { ...captured.context, id: id(), previousId: captured.contextId, version: captured.context.version + 1, recordedAt: Date.now(), compaction: { version: 2, excludedPartIds: [...(captured.context.compaction?.excludedPartIds ?? [])], summary: { proposalId: proposal.id, throughMessageId: proposal.throughMessageId, reviewedText: text, reviewedTextSha256: digest } } };
      await library.commit([library.mutation('CreateContextSnapshot', { context, select: true }), library.mutation('CreateThreadEvent', { event: { id: id(), threadId: captured.threadId, type: 'ContextCompaction', createdAt: context.recordedAt, recordedAt: context.recordedAt, messageId: proposal.throughMessageId, generationId: proposal.generationId, details: { action: 'apply_summary', proposalId: proposal.id, contextSnapshotId: context.id, previousContextSnapshotId: captured.contextId, throughMessageId: proposal.throughMessageId, sourceFingerprint: proposal.sourceFingerprint, reviewedTextSha256: digest, edited: text !== selected.generated } } })], { threadId: captured.threadId, revision: captured.revision });
      await library.loadView(captured.threadId, captured.leaf);
    }); },
    clear() { return work(async (_request, check) => { const captured = scope(); if (!contextSummary(captured.context)) return; check();
      const context: ContextSnapshot = { ...captured.context, id: id(), previousId: captured.contextId, version: captured.context.version + 1, recordedAt: Date.now(), compaction: { version: 2, excludedPartIds: [...(captured.context.compaction?.excludedPartIds ?? [])], summary: null } };
      await library.commit([library.mutation('CreateContextSnapshot', { context, select: true }), library.mutation('CreateThreadEvent', { event: { id: id(), threadId: captured.threadId, type: 'ContextCompaction', createdAt: context.recordedAt, recordedAt: context.recordedAt, messageId: captured.leaf, generationId: null, details: { action: 'clear_summary', contextSnapshotId: context.id, previousContextSnapshotId: captured.contextId } } })], { threadId: captured.threadId, revision: captured.revision }); await library.loadView(captured.threadId, captured.leaf);
    }); },
  };
}
