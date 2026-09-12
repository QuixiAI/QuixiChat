import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { contextSummary, SUMMARY_LIMITS, utf8ByteLength } from '@quixi/core/model';
import type { ContextSnapshot } from '@quixi/core/model';
import { emptyUsage } from '@quixi/providers';
import type { ProviderInput } from '@quixi/providers';
import type { ConfiguredProvider } from '../../runtime/library.ts';
import { processingRegionKey } from '../../runtime/processing-region.ts';
import { describeAttemptUsage, formatCostAmount } from '../../runtime/usage.ts';
import type { createSummaryController } from './summaries.ts';
import { useFocusRecovery } from '../accessibility/useFocusRecovery.ts';
export function SummaryCompaction({ controller, context, provider, modelId, parameters, disabled }: {
  controller: ReturnType<typeof createSummaryController>; context: ContextSnapshot;
  provider: ConfiguredProvider | undefined; modelId: string | undefined; parameters: ProviderInput['parameters']; disabled: boolean;
}) {
  const focus = useFocusRecovery();
  const cutoffId = useId();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), [through, setThrough] = useState('');
  const targetKey = JSON.stringify([provider?.id, modelId, parameters, provider ? processingRegionKey(provider) : null]);
  useEffect(() => { controller.invalidateTarget(); }, [controller, targetKey, provider?.adapter]);
  const applied = contextSummary(context), locked = disabled || state.busy, prepared = state.prepared, selected = state.selected;
  const costDecision = prepared ? controller.costDecision() : null, regionDecision = prepared ? controller.regionDecision() : null;
  const chosen = state.candidates.some(message => message.id === through) ? through : state.candidates.at(-1)?.id ?? '';
  const outputCost = prepared?.provider.adapter.estimateCost(prepared.input.modelId, { ...emptyUsage(), inputTokens: 0, outputTokens: prepared.input.parameters.maxOutputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0 }).cost;
  const inputCost = prepared && state.count?.tokens !== null && state.count?.tokens !== undefined ? prepared.provider.adapter.estimateCost(prepared.input.modelId, { ...emptyUsage(), inputTokens: state.count.tokens, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }).cost : null;
  const tooLong = utf8ByteLength(state.reviewedText) > SUMMARY_LIMITS.textBytes;
  return <section aria-label="Conversation summary" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h3 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Conversation summary</h3>
    {applied && <p role="status">A reviewed summary replaces conversation context through message {applied.throughMessageId}. Original messages remain in history.</p>}
    <button type="button" disabled={locked} aria-expanded={state.open} onClick={() => void controller.open()}>Review conversation summaries</button>
    {applied && <details><summary>Current reviewed summary</summary><p className="part-text">{applied.reviewedText}</p><button type="button" disabled={locked} onClick={() => void controller.clear()}>Clear summary and use full history</button></details>}
    {state.open && <>
      <h4>Summarize older messages</h4>
      <p>Choose a completed prefix before a user turn. A separate provider request creates a proposal; it is used only after you review and apply it. Check decisions, exact constraints, source IDs, and unresolved questions against the original messages.</p>
      {state.busy && <p role="status">Working on the summary…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
      {!state.busy && !state.candidates.length && <p>No earlier completed prefix is available before a retained user turn.</p>}
      <div><label htmlFor={cutoffId}>Summarize through message</label><select id={cutoffId} disabled={locked} value={chosen} onChange={event => { setThrough(event.target.value); controller.invalidateTarget(); }}>
        {!chosen && <option value="">No eligible cutoff</option>}
        {state.candidates.map((message, index) => <option key={message.id} value={message.id}>{index + 1}. {message.role} · {message.id}</option>)}
      </select></div>
      <button type="button" disabled={locked || !provider || !modelId || !chosen} onClick={() => { if (provider && modelId) void controller.prepare(chosen, provider, modelId, parameters); }}>Prepare summary request</button>
      {prepared && <section aria-label="Review summary request">
        <p>Send {prepared.info.sourceMessageCount} messages and {prepared.info.sourcePartCount} source parts through {prepared.through} to {prepared.provider.label} · {prepared.input.modelId} · privacy: {prepared.provider.privacy ?? 'unknown'}. {prepared.textBytes} text bytes, {prepared.imageBytes} image bytes; {prepared.omitted} internal or redacted parts omitted. Existing attachment exclusions apply. Earlier reviewed summary text is included when extending a summary.</p>
        <p>Output limit: {prepared.input.parameters.maxOutputTokens} tokens; only a complete text response up to 16 KiB can be applied. Source history and the exact request body are retained.</p>
        <p>{outputCost ? `Output at the selected cap: up to ≈ ${formatCostAmount(outputCost.amount)} ${outputCost.currency}, estimated from reviewed pricing.` : 'No reviewed output price is available.'} {inputCost ? `Counted input: ≈ ${formatCostAmount(inputCost.amount)} ${inputCost.currency}, estimated.` : 'Count the input for an available input estimate.'}</p>
        {costDecision && <p role="status">Summary cost check: {costDecision.reason}. This applies to this summary attempt; it does not limit total charges across other attempts.</p>}
        {regionDecision && <p role="status">Summary processing-region check: {regionDecision.reason}{regionDecision.basis ? ` Basis: ${regionDecision.basis}` : ''}</p>}
        <details><summary>Inspect prepared summary input</summary><pre>{prepared.body}</pre></details>
        <label><input type="checkbox" disabled={locked} checked={state.requestReviewed} onChange={event => controller.reviewRequest(event.target.checked)} />I reviewed this summary request and its destination</label>
        <button type="button" disabled={locked || !state.requestReviewed || !regionDecision?.allowed} onClick={() => void controller.count()}>Count summary input</button>
        <p role="status" aria-atomic="true" className="summary-count-status">{state.count ? state.count.tokens === null ? `Token count unavailable: ${state.count.reason ?? 'This connection does not provide a token count.'}` : `${state.count.tokens} input tokens; ${prepared.report.context.inputRoom ?? 'unknown'} tokens of input room.` : ''}</p>
        <button type="button" disabled={locked || !state.requestReviewed || !regionDecision?.allowed || !costDecision?.allowed || state.count?.tokens !== null && state.count?.tokens !== undefined && prepared.report.context.inputRoom !== null && state.count.tokens > prepared.report.context.inputRoom} onClick={() => void controller.generate()}>Generate summary proposal</button>
      </section>}
      <section aria-label="Saved summary proposals"><h4>Saved proposals</h4>
        {state.proposals.map(proposal => <button type="button" disabled={locked} key={proposal.id} onClick={() => void controller.select(proposal)}>Inspect proposal {proposal.id.slice(0, 8)} · {new Date(proposal.recordedAt).toLocaleString()}</button>)}
        {state.next && <button type="button" disabled={locked} onClick={() => void controller.next()}>Next summary proposals</button>}
      </section>
      {selected && <section aria-label="Review proposed summary">
        <h4>Review proposal</h4>
        <p>{selected.generation.status} · {selected.generation.provider} · {selected.generation.model} · through {selected.proposal.throughMessageId}</p>
        <p>Summary usage: {describeAttemptUsage(selected.generation)}</p>
        {selected.refusal && <p role="alert">This proposal cannot be applied: {selected.refusal}</p>}
        <details><summary>Original generated text</summary><p className="part-text">{selected.generated || '(No retained text)'}</p></details>
        <button type="button" disabled={locked} onClick={() => void controller.inspectInput()}>Inspect saved summary input</button>
        {state.frozenInput && <details open><summary>Verified saved request body</summary><pre>{state.frozenInput}</pre></details>}
        <label>Reviewed summary<textarea aria-label="Reviewed summary" disabled={locked || !!selected.refusal} value={state.reviewedText} maxLength={SUMMARY_LIMITS.textBytes} onChange={event => controller.edit(event.target.value)} /></label>
        <p>{utf8ByteLength(state.reviewedText)} / {SUMMARY_LIMITS.textBytes} UTF-8 bytes. Applying preserves generated text and source history separately.</p>
        {tooLong && <p role="alert">Shorten the reviewed text to 16 KiB.</p>}
        <label><input type="checkbox" disabled={locked || !!selected.refusal || tooLong} checked={state.textReviewed} onChange={event => controller.reviewText(event.target.checked)} />I checked this summary against the source messages and want to use it</label>
        <button type="button" disabled={locked || !!selected.refusal || tooLong || !state.reviewedText.trim() || !state.textReviewed} onClick={() => void controller.apply()}>Apply reviewed summary</button>
      </section>}
      {state.busy ? <button type="button" onClick={() => void controller.cancel()}>Stop summary</button> : <button type="button" onClick={() => controller.reset()}>Close summary review</button>}
    </>}
  </section>;
}
