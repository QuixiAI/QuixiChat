# Branch and alias review accessibility

This increment extends the production shared-application proof with keyboard
focus after review controls disappear, summary labels and count announcements,
and computed layout/contrast checks. It uses the actual application, storage
worker and disposable synthetic history/provider fixtures.

## Measured baseline

The [retained baseline](results/attempts/review-accessibility-baseline/review-accessibility-chromium-alias-editor.json)
measured the alias editor before the stylesheet correction. At 320 CSS pixels
its horizontal form reduced the fieldset to a narrow column. At 200% root text
size, the document measured 560px wide for a 320px viewport, with fields and
buttons extending outside it. Enabled authored input boundaries measured about
1.76:1 against their fill and 1.68:1 against surrounding page color. The capture
run deliberately stopped after recording these findings; it is not a passing
application report.

The correction gives the alias editor a vertical layout and a shrinkable grid
fieldset. Text can wrap in long labels and fallback names. The shared authored
input/select/textarea border changes from `#bac6bd` to `#718176`; text-button
borders and browser-native checkbox/radio painting are outside this correction.

The populated summary review subsequently exposed an enlarged-text button
extending beyond its containing composer. The [retained measurement](results/attempts/review-accessibility-summary-reflow/review-accessibility-chromium-summary-review.json)
records the button at 226.86px in a 170.84px review content area. Composer buttons
now wrap within their available width. The summary label also uses an explicit
`label`/`select` association so option text cannot become part of the label
lookup; the exact accessible name is checked in the production browser.

WebKit then exposed native select overflow at enlarged text: closed controls fit
their boxes, but their containing fields reported wider scrollable content and
the page reached 475–514px. [Bounded element diagnostics](results/attempts/review-accessibility-webkit-reflow/element-diagnostic.json)
locate that overflow. A [temporary-style comparison](results/attempts/review-accessibility-webkit-select/review-accessibility-webkit-select-overflow.json)
showed that `overflow: hidden` on the select itself kept the document at 320px;
appearance and inline-size containment alternatives did not. The shared select
style now contains its closed-control overflow. No page or review overflow is
hidden, and the underlying HTML select options, labels and handlers remain.
Alias target/region controls also use explicit label associations; checkbox
width and field layout are explicit rather than relying on native grid sizing.

## Focus and review behavior

The [first removal run](results/attempts/review-accessibility-removal/alias-removal-focus.json)
left focus on BODY when the focused middle fallback was removed. React can
emit focusout before an enabled control is detached, which the earlier helper
treated as deliberate blur. The helper now keeps a unique pending-blur marker
until the layout effect/microtask can distinguish a detached control from an
enabled control deliberately blurred in place. Refocus, pointer movement and
unmount invalidate the marker. Existing explicit-origin/heading blur and
window-return regressions remain in the same browser run.

- Opening an alias editor focuses Alias name. Saving, cancelling, keeping or
  deleting an alias, removing a fallback, and moving a fallback into its disabled
  first position retain focus at a stable Routing aliases heading when the
  initiating control disappears or becomes unavailable. Applying/cancelling an
  alias review uses its stable Apply routing alias heading.
- Attachment and summary panels keep stable headings across review closure.
  Temporary disabled controls regain focus after work completes, unless focus
  has moved elsewhere. The existing helper also yields after explicit blur.
- Fresh-branch consent still expires on exactly the prior source key (thread,
  revision, context, leaf and disabled state), but the focus boundary no longer
  remounts with that key. A changed title/revision is exercised while consent is
  focused and while the user has moved to Title; the former retains a stable
  heading and the latter keeps the user's focus. Reopening requires fresh
  consent. Completion no longer forces focus back to the composer.
- The summary cutoff select takes its accessible name from the visible
  “Summarize through message” label. A persistent atomic status node announces
  the completed count; generated text and request bodies are not live regions.

## Verification

Final qualification passes **54 application groups in Chromium and 54 in
Playwright WebKit**, **31 summary/compaction tests**, **12 preference/alias
tests**, and `npm run check`. The [application report](results/review-accessibility-app-macos.json)
and [aggregate record](results/review-accessibility-checks-macos.json) retain
90 matching source hashes, commands, logs and 62 artifacts. The complete run
finished with unchanged source hashes on macOS 26.6.2 / arm64 / Node 22.23.1.

The application runner includes the existing
canonical preservation, review binding, lost replies, exact provider request,
portable restore and process-restart assertions alongside the new keyboard
checks. New helpers retain bounded layout/focus diagnostics and screenshots.

The layout proof measures 320px at normal and 200% root text size separately for
an initially unconfigured alias editor, a populated alias with an unavailable
fallback, and attachment/summary/fresh-branch reviews. It checks document and
control bounds and computes authored border contrast from actual CSS colors;
threshold comparisons use unrounded ratios. All ten layout cases (five per
engine, each measured at both text sizes) pass. Sampled authored borders measure
4.115:1 against white fill and 3.927:1 against the page; thresholds use the
unrounded values. Representative viewport screenshots were visually inspected
in both engines for wrapping, readable controls and visible focus. Closed native
selects can truncate long option text; their popup painting is not qualified.
The alias removal fixture exercises middle, first and last fallback removal,
cancel, keep and confirmed deletion; it restores the original empty registry
with exactly two durable revisions and no provider dispatch.

One [earlier full run](results/attempts/review-accessibility-stream-interruption/app-browser.json)
failed waiting for Stop response after the generation recorded a partial
provider transport failure. The final complete run did not reproduce it. The
failed report and log are retained; no transport repair is claimed.

These checks do not establish actual screen-reader output, browser-native control
painting, installed Safari behavior, every app state or full WCAG conformance.
The separate Apply routing alias selector with long saved names is not part of
the five measured layouts. Remaining work stays in [the accessibility findings](accessibility-open-findings.md)
and plans 08/13.

## References

Reviewed 2026-09-10: W3C [Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
explains the 3:1 requirement for authored visual information needed to identify
controls and states; optional text-button boundaries are not automatically
required. [Label in Name](https://www.w3.org/WAI/WCAG22/Understanding/label-in-name.html)
explains retaining visible label words in the accessible name.
[Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) provides the
320 CSS-pixel reference. The additional root-font-size test is explicitly a text
scaling test, not a claim to emulate every browser zoom configuration.
