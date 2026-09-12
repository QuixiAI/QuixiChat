import { useState, useSyncExternalStore } from "react";
import type { createCompactionController } from "./controller.ts";
import { useFocusRecovery } from '../accessibility/useFocusRecovery.ts';
export function AttachmentCompaction({ controller, disabled, apply }: { controller: ReturnType<typeof createCompactionController>; disabled: boolean; apply: (ids: string[]) => void }) {
  const focus = useFocusRecovery();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const reviewKey = JSON.stringify([state.scope, state.selected]);
  return <section aria-label="Attachment exclusions" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h3 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Attachment exclusions</h3>
    {state.scope && <section aria-label="Review attachment exclusions">
    <h4>Exclude attachments from requests</h4>
    <p>Choose attachment occurrences to replace with “[Attachment omitted by your context choice.]” in future requests in this conversation. Their filenames, descriptions and bytes will not be sent. Original history and files remain here. New attachments and other occurrences are unchanged.</p>
    {state.busy && <p role="status">Reading attachment metadata…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.ready && <>
      {!state.choices.length && <p>No attachments in this branch or its current exclusions.</p>}
      {state.choices.map(choice => <label key={choice.partId}>
        <input type="checkbox" disabled={disabled} checked={state.selected.includes(choice.partId)} onChange={event => controller.select(event.target.checked ? [...state.selected, choice.partId] : state.selected.filter(id => id !== choice.partId))} />
        {choice.label} · {choice.kind} · message {choice.messageId.slice(0, 8)}{choice.onBranch ? "" : " · outside this branch (already excluded)"}
      </label>)}
      <p>{state.selected.length ? `${state.selected.length} occurrence(s) will be excluded. A token count is needed to check whether the prompt fits.` : "No occurrences selected: applying will clear the current attachment exclusions."}</p>
      <label><input type="checkbox" disabled={disabled} checked={reviewed === reviewKey} onChange={event => setReviewed(event.target.checked ? reviewKey : null)} />I reviewed these attachment exclusions</label>
      <button type="button" disabled={disabled || reviewed !== reviewKey} onClick={() => { setReviewed(null); apply(state.selected); }}>Apply attachment exclusions</button>
    </>}
    <button type="button" onClick={() => { setReviewed(null); controller.cancel(); }}>Cancel attachment review</button>
    </section>}
  </section>;
}
