# Accessibility audit across completed workflows

Date: 2026-09-12. Plan: [13](../plans/13_complete_onboarding_appearance_and_accessibility.md).
Runs inside the shared-app proof (`npm run test:app:browser`, 91 checks per
engine) through [audit.mjs](../../packages/app/tests/browser/audit.mjs) on
ten views in Chromium and WebKit.

## What the audit checks

A self-contained DOM and computed-style audit of the current view, in the
real engines, with no external rule engine:

1. **Accessible names** — every visible button, link, input, select,
   textarea, summary and image has a name (aria-label, aria-labelledby,
   an associated or wrapping label, title, value or text; images may
   declare an empty alt).
2. **Contrast** — every visible text node against its effective background
   (alpha-composited up the ancestor chain to the root) at 4.5:1 or better,
   3:1 for large text; disabled controls and visually hidden text are
   excluded.
3. **Landmarks** — same-role landmarks (navigation, complementary, region,
   search, form) carry unique names; unnamed sections are not landmarks.
4. **Headings** — visible heading levels never skip.
5. **Streaming announcements** — no live region exists inside the message
   list; the polite generation status is the only place a reply announces.
6. **Alerts carry text** — an empty alert is a defect; empty polite status
   placeholders are permitted and counted, since a live region must exist
   before its text changes to be announced.
7. **Focus visibility** — on views audited outside a focus-tracked flow,
   the first six focusable controls show a non-zero outline when focused,
   and the previously focused element is restored afterwards.

## Result (Chromium / WebKit)

| View | Controls | Text nodes | Landmarks | Headings | Empty status placeholders | Focus samples |
| --- | --- | --- | --- | --- | --- | --- |
| welcome | 23 / 23 | 30 / 30 | 5 | 3 | 0 | 6 |
| conversation | 156 / 160 | 260 / 260 | 21 | 8 | 0 | 0 |
| search results | 70 / 70 | 99 / 99 | 16 | 9 | 1 | 0 |
| imports | 26 / 26 | 43 / 43 | 7 | 4 | 0 | 0 |
| providers | 66 / 66 | 135 / 135 | 5 | 6 | 0 | 6 |
| preferences | 46 / 46 | 63 / 71 | 6 | 6 | 0 | 6 |
| documents | 34 / 34 | 38 / 40 | 7 | 2 | 0 | 6 |
| exports | 33 / 35 | 43 / 49 | 6 | 4 | 0 | 6 |
| semantic | 32 / 32 | 37 / 37 | 5 | 2 | 0 | 6 |
| storageHealth | 33 / 33 | 50 / 50 | 6 | 3 | 0 | 6 |

No unnamed control, contrast shortfall, duplicate landmark, skipped heading
level, live region inside the message list, empty alert or missing focus
outline was found on any view in either engine. The audit runs under the
default theme; the six-theme scenario checks body and muted contrast for
every theme separately ([interaction-preferences.md](interaction-preferences.md)).

## Earlier and remaining findings

The [pre-fix static review](accessibility-open-findings.md) and the
[review](review-accessibility.md), [action](action-accessibility.md),
[keyboard-focus](keyboard-focus.md) and [pending-recovery](pending-recovery.md)
qualifications record the defects found and fixed before this audit. What
remains outside this audit's reach: actual assistive-technology output
(installed screen readers), host-native control painting, and the desktop
host — release qualification, not a defect found here.
