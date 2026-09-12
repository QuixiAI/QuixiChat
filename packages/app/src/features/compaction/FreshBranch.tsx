import { useState } from 'react';
import type { FreshBranchScope, LibrarySnapshot } from '../../runtime/library.ts';
import { useFocusRecovery } from '../accessibility/useFocusRecovery.ts';

/** The review is keyed to its exact source; changing the selection discards consent. */
export function FreshBranch({ snapshot, disabled, apply }: {
  snapshot: LibrarySnapshot; disabled: boolean; apply: (scope: FreshBranchScope) => void;
}) {
  const focus = useFocusRecovery();
  const view = snapshot.thread;
  const key = JSON.stringify([view?.thread.id, view?.state.revision, view?.context.id, snapshot.leaf, disabled]);
  const [review, setReview] = useState({ key, open: false, reviewed: false });
  // Reset the same consent scope as the former keyed child, while preserving
  // the heading and focus boundary across stale-scope and disabled transitions.
  if (review.key !== key) setReview({ key, open: false, reviewed: false });
  const open = review.key === key && review.open, reviewed = review.key === key && review.reviewed;
  const close = () => setReview({ key, open: false, reviewed: false });
  const leaf = snapshot.leaf, available = !!leaf && view?.state.activeLeafMessageId === leaf;
  return <section aria-label="Fresh context branch" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
    <h3 ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Fresh context branch</h3>
    {!leaf && snapshot.branches.items.length > 0 && <p role="status">An empty branch is selected. Your next Send starts a new conversation path. Use Show starting branches to reopen earlier history.</p>}
    <button type="button" disabled={disabled || !available} aria-expanded={open} onClick={() => setReview({ key, open: true, reviewed })}>Review fresh branch</button>
    {open && view && <section aria-label="Review fresh branch">
      <h4>Start a fresh branch from here</h4>
      <p>Keep this conversation’s current system prompt, routing, attachment exclusions, and your unsent draft and attachments. Earlier messages and any applied summary will be excluded from the new branch’s requests. They remain accessible in the original history.</p>
      <details><summary>System prompt carried forward</summary><p className="part-text">{view.context.systemPrompt || '(No system prompt)'}</p></details>
      <p>Starting the branch sends nothing to a provider. Your next Send creates its first message.</p>
      <label className="checkbox"><input type="checkbox" checked={reviewed} disabled={disabled} onChange={event => setReview({ key, open: true, reviewed: event.target.checked })} />I want to start fresh without earlier messages or the applied summary</label>
      <button type="button" disabled={disabled || !available || !reviewed} onClick={() => {
        if (!leaf) return;
        close();
        apply({ threadId: view.thread.id, revision: view.state.revision, contextId: view.context.id, leaf });
      }}>Start fresh branch</button>
      <button type="button" onClick={close}>Cancel branch review</button>
    </section>}
  </section>;
}
