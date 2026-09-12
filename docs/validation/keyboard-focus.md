# Keyboard focus during asynchronous work

The shared application browser proof exercises focus through production panels,
the browser host and StorageWorker. Files, history, credentials and provider
responses are synthetic and confined to the disposable fixture profile.

## Retained initial observation

Before panel changes, `QUIXI_TEST_BROWSERS=chromium npm run test:app:browser`
failed at the focused Send key control after a successful durable preference
save. The Preferences button was activated with Enter. The select was focused,
its option changed, and the proof waited for the saved value and completion
status. Focus was then on `BODY`, while the select was enabled again.

The [baseline report](results/attempts/keyboard-focus-baseline-chromium.json)
records the failure and 81 matching source hashes at capture. The
[focused diagnostic](results/attempts/keyboard-focus-baseline-diagnostic.json),
[screenshot](results/attempts/keyboard-focus-baseline.png) and
[log](results/attempts/keyboard-focus-baseline.log) preserve the observed state.

Headless macOS Chromium did not commit the attempted native select arrow-key
sequences, so those preliminary attempts did not establish a product defect.
The retained failure uses Playwright's `selectOption` after explicitly focusing
the control. The extended proof also uses Space on a checkbox to exercise a
fully keyboard-activated preference change.

The first fix run exposed an additional setup race: focusing the select before
initial preference loading finished could leave focus on the Preferences
navigation button. The final proof requires the control to be enabled and
focused before mutation. The initial baseline did not assert those preconditions
and therefore is not sufficient by itself to isolate the cause of lost focus.
Both observations remain preserved under `results/attempts/keyboard-focus-*`.

## Qualification

Final Chromium and Playwright WebKit qualification passes **51 groups per
engine** on macOS 26.6.2. The [retained application report](results/keyboard-focus-app-macos.json)
checks 88 source hashes for changes during the run; the
[aggregate record](results/keyboard-focus-checks-macos.json) verifies those hashes
against the final worktree and records log, diagnostic and screenshot hashes.
`npm run check` passes. Preference tests (12), archive controller tests (23,
including seven new export regressions) and provider settings tests (16) pass:
**51 controller tests**. Run `npm run test:app:browser` to repeat the UI proof.

The final 390px/200% text screenshots for
[Chromium](results/keyboard-focus/keyboard-focus-chromium-preferences-enlarged.png)
and [WebKit](results/keyboard-focus/keyboard-focus-webkit-preferences-enlarged.png)
were visually inspected: the focused select and labels remain visible without
horizontal page overflow. This is representative Preferences coverage, not a
claim about every editor or a full 320px reflow audit.

The added checks cover:

- Preference saves retain focus on re-enabled controls. A test-only gate holds
  one reply after the real durable write, allowing Tab to move outside the
  pending panel; releasing the reply must not move focus back. Defaults are
  restored afterward. A 390-pixel viewport with 200% root text size checks
  representative layout and preserved focus.
- A controlled window-return scenario emulates `document.hasFocus`, window
  events and explicit origin blur around a real durable preference write.
  Recovery waits until the document regains focus. An enabled origin deliberately
  blurred without a save stays unfocused after window return and the resulting
  background preference refresh. This is not a native-dialog qualification.
- Explicitly blurring the parked heading also cancels recovery. The
  [negative browser proof](results/attempts/keyboard-focus-heading-blur-chromium.json)
  and [stage diagnostic](results/attempts/keyboard-focus-heading-blur-diagnostic.json)
  show the earlier helper reclaiming focus on the select after a durable save,
  despite the heading having been deliberately blurred. The fix handles the
  parked heading's focusout as well as the original control's.
- Provider credential connection and connection checking are activated with
  Enter. Focus survives asynchronous disabling and the Connect-to-Replace
  button label change.
- Export preparation restores its initiating control. Saving, releasing a
  prepared export and clearing a checked temporary download move focus to the
  stable export heading when the original control disappears.
- The import picker, start and report controls work by keyboard. Completion
  releases the selected file, so the disabled start control leaves focus at the
  import heading. Opening a saved conversation focuses its new heading.
- Portable restore preserves focus through file selection and replacement
  review. Releasing candidate work and completing activation move focus to the
  restore heading when controls disappear. The same archive is then selected
  again and restored through the existing reviewed activation path.
- Bounded DOM observers inspect import/export/restore phase announcements:
  each uses an atomic status node with a phase name, and changing byte and
  record counters remain outside its live subtree.

These are browser keyboard, DOM focus and accessibility-semantics checks. They
do not claim testing with a screen reader, other assistive technology, installed
Safari or every platform's native file dialog. Existing archive byte, canonical
history, provider mapping and restart checks remain in the same run.

Sources: [focus helper and assertions](../../packages/app/tests/browser/keyboard-focus.mjs),
[application proof](../../packages/app/tests/browser/run.mjs), and
[portable restore proof](../../packages/app/tests/browser/composer-files.mjs).

## Export admission correction

Keyboard activation exposed an enabled Prepare control whose request was ignored
while the panel's initial archive listing occupied the controller. The
[retained run](results/attempts/keyboard-focus-export-initialization-chromium.json)
reached the export flow and never obtained a prepared archive. The controller
now publishes busy for every admitted operation, reserves admission before
notifying subscribers, and releases admission before publishing idle. It does
not queue a rejected activation. Save/release controls also respect busy, while
Cancel preparation appears only when an actual preparation can be cancelled.

Seven focused export controller regressions cover held initialization, failure
recovery, subscriber reentry, prepare/resume cancellation and disposal before
deferred dispatch. The first three fail against the reconstructed original
controller; the two disposal cases fail without the new pre-dispatch disposal
guard. Those negative proofs use temporary copies, not edits during browser
qualification. `npm run test:app:archives` includes both restore and export
controller regressions.

## Remaining accessibility work

The [bounded review findings](accessibility-open-findings.md) track remaining
alias/compaction removal focus, a summary-select label mismatch, input-boundary
contrast, narrow alias editing and assistive-technology checks. These findings
keep the broader plan 08/13 accessibility task open. Browser DOM focus and live
region structure do not establish spoken output, native platform coverage or a
complete contrast/reflow audit.
