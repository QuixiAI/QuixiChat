# Branch, switch, and review controls: bounded accessibility review

Reviewed 2026-09-10 from current source, before the concurrent shared panel-focus changes. This is a static review plus calculated CSS color contrast, not a browser or assistive-technology qualification. No browser was run and no production source was changed for this review. Findings below must be reconciled against the final implementation and its retained tests.

The later [action-accessibility qualification](action-accessibility.md) passes
59 application groups in both engines, 97 unit tests and `npm run check`.
It adds context to message/article actions and conversation fallback removal,
qualifies the long-name alias application selector/review, and replaces repeated
compatibility alerts with one persistent atomic last-settled status. The same
run verifies visible Workspace status recovery, known-refusal dismissal,
non-dismissible unknown outcomes, and focus moved away during a held reply.

The subsequent [pending-recovery qualification](pending-recovery.md) resolves
the navigation/search gap: recovery has its own origin-scoped record and region,
independent of the ordinary error cleared by those operations. Both engines
preserve recovery through dismissal/navigation/search and preserve newer focus
through a held exact retry. Ordinary errors are now independently dismissible.
Actual screen-reader output and wider host/state qualification remain open.

The subsequent [review accessibility qualification](review-accessibility.md)
resolves the measured label, authored-border, alias-editor reflow and tested
alias/compaction focus findings below. The table is the retained **pre-fix audit**,
not a statement that every listed defect remains in current source. The final
production run passes 54 groups per engine with 90 matching source hashes.

Current resolution and remaining scope:

- The summary select now has the exact visible accessible name. Enabled authored
  borders exceed 3:1 against their measured fill and surroundings.
- Alias editor and attachment/summary/fresh-branch reviews fit 320px at normal and
  200% root text size in both engines. The later action qualification adds the
  separate Apply routing alias selector and review with a 64-character name.
- Keyboard removal of middle/first/last alias fallbacks, cancel/keep/delete,
  save, disabled Move-up and application review now retain stable headings.
  Fresh-branch stale-scope consent expires while recovery respects user focus.
- Summary count completion has a persistent atomic status node and DOM checks.
  Actual screen-reader delivery and ordering remain unverified.
- Compatibility-alert DOM churn, repeated message/action names and the exercised
  global recovery removal paths now have the later action qualification. Actual
  announcement delivery remains open; navigation/search recovery is qualified by
  the later pending-recovery proof.
- Installed screen readers, native-control painting, full state/theme coverage
  and actual host accessibility remain release qualification work.

Scope: `packages/app/src/AppRoot.tsx`, `features/compaction/{FreshBranch,AttachmentCompaction,SummaryCompaction}.tsx`, `features/preferences/RoutingAliases.tsx`, and `styles.css` under `packages/app/src/`.

| Priority | Concrete source evidence | Bounded correction or remaining gate |
| --- | --- | --- |
| P1 | `SummaryCompaction.tsx:34`: visible label **Summarize through message**, overridden by `aria-label="Summary cutoff"`. The accessible name does not include the visible label. | Let the wrapping label name the select, or align its accessible name with the visible words. Verify the final accessible name and speech targeting. This is a source-established label mismatch under [W3C Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html). |
| P1 | `styles.css:29–35,63–71`: authored control border `#bac6bd`, white control background, pale page background. Calculated contrast is **1.765:1 against white**, **1.684:1 against `#f9faf7`**. In an empty text field, this pale boundary supplies the field's visible extent. | Increase the empty-field boundary contrast and verify computed colors in the final rendered control. W3C requires 3:1 for visual information needed to identify an active control; a text button does not automatically fail just because its optional border is pale. Disabled controls are also exempt. [W3C Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). |
| P1 | `FreshBranch.tsx:9–10,29–34`: changing revision/context/leaf/**disabled** remounts the entire review subtree; cancel removes its focused button. `AttachmentCompaction.tsx:6,21–23` removes the review on cancel or after apply. `SummaryCompaction.tsx:27,69` removes its inner review on reset. No focus recovery was present in the inspected versions. | The shared focus fix must cover successful completion, cancellation, stale-scope invalidation, and a disabled/busy transition while focus is inside. Verify a surviving, enabled target receives focus and later asynchronous updates do not steal it from a user who has moved elsewhere. The DOM-removal mechanism is established; actual browser focus destination is unmeasured. |
| P1 | `RoutingAliases.tsx:63–64,76,90–91,108,129–130`: confirm-delete, keep, save, cancel-edit, remove-fallback, and apply/cancel-application can remove the active element. Removing the alias also removes its original Edit/Delete opener. Moving a fallback upward into first position disables that row's Move-up control. | Focus recovery needs a surviving fallback, not only the original opener: adjacent alias/fallback control or New alias/Add fallback. Verify removal of first, middle, and last items, successful save/delete, and failed writes that leave the editor intact. These list-item paths extend beyond opening/closing a review panel. |
| P1 | `RoutingAliases.tsx:67–108` renders heading, optional error, fieldset, and cancel button as direct children of a form. `styles.css:105–114` gives all forms a horizontal flex row with no wrap. No alias-editor override or fieldset minimum-size reset was present. | Strong static risk of cramped or overflowing alias editing. Inspect at 320 CSS px, with a long alias/model name, all fallback controls, validation text, and enlarged text. Use a vertical editor layout and a shrinkable fieldset if reproduced. Actual overflow has not been measured. The reflow reference is [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html), which relates 320 CSS px to a 1280 CSS px viewport at 400% zoom. |
| P2 | `AppRoot.tsx:742–773` clears and rebuilds compatibility inspection when generation settings change; `2019–2033` mounts an alert for each blocked item/constraint. Typing several successive valid output limits can repeatedly remove and reinsert the same blocked explanations. | Test a blocked switch while typing settings with a screen reader. Potential repeated/interrupted announcements are inferred, not observed. Prefer a stable concise result announcement with the full report available for reading if churn is confirmed. |
| P2 | `SummaryCompaction.tsx:30–49`: the generic Working status disappears when counting finishes, while the actual token count is an ordinary paragraph. Cost/region status text may remain unchanged when a count becomes available. | Verify that Count summary input completion is discoverable without searching the page; add a concise count-completion announcement if necessary. Do not make the whole request body or generated text a live region. |
| P2 | `AppRoot.tsx:1841–1851` gives every fallback deletion button the accessible name **Remove**. Per-message actions such as Continue from here also repeat across unnamed message articles (`1423–1550`). | Check screen-reader buttons-list navigation with multiple fallbacks/messages. Include the target in the removal name and provide usable message context. This is an ambiguity/usability finding, not a claim that repeated names alone violate a criterion. |

Already-present protections matter: native buttons/selects/checkboxes provide their ordinary keyboard behavior; reviewed checkboxes have wrapping labels; `pre` and message text wrap; the narrow breakpoint switches both composer layouts to one column; and the generation status at `AppRoot.tsx:2215–2227` uses stable text while streaming rather than announcing each token. A React rerender alone does not establish a repeated announcement.

Calculated contrast checks on the inspected stylesheet also found `#278264` focus outline against white **4.705:1**, against page `#f9faf7` **4.491:1**, and against sidebar `#eff3ec` **4.190:1**. Muted text `#58675e` against page calculates **5.700:1**; primary white text against `#2c624b` calculates **7.105:1**. Calculations used sRGB relative luminance and `(lighter + 0.05)/(darker + 0.05)`; displayed ratios are rounded for reporting. These sampled pairs do not establish coverage of every control, selected state, browser-native checkbox, focus clipping, or forced-colors mode.

Final bounded gates: retain keyboard focus assertions for the removal/remount paths above; inspect the final accessible names; render the alias editor and all three reviews at narrow width and enlarged text; inspect active empty-input boundaries; and manually record a screen-reader pass for compatibility errors and summary-count completion. Shared panel-focus implementation or automated DOM tests alone do not settle the last two rendering/announcement gates.
