# 13 — Complete onboarding, appearance, and accessibility

**Status:** In progress — interaction preferences, the five-step first-run onboarding and the §13/§14 storage status pass two-engine qualification ([onboarding](../validation/onboarding.md)); themes and the broader accessibility audit remain open

**Workstream:** Shared product experience

**Depends on:** [04](./04_import_provider_exports.md), [08](./08_build_chat_and_library_ui.md), [09](./09_add_archives_and_open_export.md), [10](./10_add_routing_and_provider_switching.md), [11](./11_build_browser_extension_import.md)

## Outcome

Make the local-first product understandable and accessible from first launch through everyday use, import, switching, and backup.

## Product references

- [2. Product positioning](../product.md#2-product-positioning)
- [13. Storage UX](../product.md#13-storage-ux)
- [14. Persistence status](../product.md#14-persistence-status)
- [15. Storage quota UX](../product.md#15-storage-quota-ux)
- [28. Import UX](../product.md#28-import-ux)
- [29. Core chat experience](../product.md#29-core-chat-experience)
- [46. Search result UX](../product.md#46-search-result-ux)
- [92. Appearance](../product.md#92-appearance)
- [93. Accessibility](../product.md#93-accessibility)
- [94. Onboarding](../product.md#94-onboarding)
- [110. Release/platform risks](../product.md#110-releaseplatform-risks)

## Tasks

- [x] Implement onboarding steps for local-storage disclosure, capability checks, bringing history, connecting providers now or later, and optional semantic-search enrollment when available. — `packages/app/src/features/onboarding/` renders product §94 steps 1–5 on the landing until completed or skipped (device-local preference row v3, [ADR 0018 addendum](../decisions/0018-local-preferences-and-routing-presets.md#onboarding-state--2026-09-12)); step 2 reads actual diagnostics and host capabilities, step 3 links extension/export/archive imports, step 4 reports configured connections, step 5 enrols semantic search through the plan 21 controller; Preferences can show it again. Eight checks per engine in the [onboarding qualification](../validation/onboarding.md).
- [x] Show actual persistence-grant and quota state, device/profile/origin ownership, and export/backup actions. Do not equate successful startup with guaranteed storage durability. — the §13/§14 storage block (onboarding step 2 and the Storage health section) reports the worker's persistence observation and the host's `persistentStorage` capability, usage/quota, the ownership note and Export backup; "Request persistent storage" reports the browser's actual answer (both headless engines refuse it, shown as not granted with the eviction warning).
- [x] Complete import and compatibility warning review, recoverable error states, empty states, and progress/cancellation presentation across the application. — [presentation-review.md](../validation/presentation-review.md) maps every completed workflow's warning review, recoverable errors, empty states and progress/cancellation to the proof that exercises it; the review added the three missing empty states (no search matches, an empty conversation, no provider connections), two of them asserted in the shared-app proof.
- [x] Implement Warm Reading, Cool Minimal, Compact Ops, Terminal, Bubbles, and Focus themes through shared appearance tokens and layouts. — [ADR 0039](../decisions/0039-appearance-themes.md): the stylesheet is tokenized (no literal colour outside the token definitions), each theme is a root `data-theme` block over the tokens plus its few layout rules, the theme is a version-4 device-local preference with its own `setTheme` operation, and the Preferences panel selects it; the shared-app proof exercises all six ([interaction-preferences.md](../validation/interaction-preferences.md)).
- [x] Keep interaction settings independent of themes: send-key behavior, timestamps, model badges, composer layout, and model-switcher style. Persist preferences through the agreed local settings path.

  Complete for the interaction settings (2026-09-10): [ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md)
  defines the version-2 worker-owned local row, compatible version-1 defaults,
  conditional revisions and separate routing-alias record. All five choices are
  implemented. [Interaction preference qualification](../validation/interaction-preferences.md)
  covers controller/storage failures, stale views, unchanged drafts and canonical
  history, both layouts, dropdown/list models, and process restart in both engines
  (46 application groups each). Themes remain a separate task; their independence
  acceptance criterion below is not claimed before they exist.
- [x] Audit keyboard navigation, focus restoration, contrast, screen-reader labels, scalable text, reduced motion, non-color status, and streaming announcements across all completed workflows. — [accessibility-audit.md](../validation/accessibility-audit.md): an in-page audit runs on ten views in both engines inside the shared-app proof (accessible names on every visible control, 4.5:1 contrast for every visible text node, unique landmark names, no skipped heading levels, no live region inside the message list, alerts with text, focus outlines), finding nothing; keyboard navigation and focus restoration are qualified by [keyboard-focus.md](../validation/keyboard-focus.md), [action-accessibility.md](../validation/action-accessibility.md), [review-accessibility.md](../validation/review-accessibility.md) and [pending-recovery.md](../validation/pending-recovery.md); scalable text by the 320px/200% captures; reduced motion by the animation-free stylesheet under its guard; non-colour status by text in every status and health state; streaming announcements by the counted generation status. Actual assistive-technology output remains the criterion below.
- [x] Test narrow windows, large text, long titles/content, missing metadata, offline states, and ungranted persistent storage. Record remaining accessibility defects as release blockers where core flows are unusable. — Narrow windows: the 390px restart scenario and the 320px captures of the library and an open conversation; large text: the same captures and the review/alias layouts at 200% root text; long titles/content: a 160-character title with a 70-character unbroken token (library, heading, settings form at 320px/200%), the 64-character alias name, the 2,000-message conversation and the two-part 16 KiB response; missing metadata: the import panel's missing-attachment and unsupported-content notices and "not configured" fallback candidates after a restart; offline states: the composer's offline signal refuses sending with its reason and the health probe is suppressed while offline ([health-refresh](../validation/background-health.md)); ungranted persistent storage: onboarding step 2 reports the browser's actual answer and the storage status shows "Not granted" with the request action ([onboarding.md](../validation/onboarding.md)). No core flow was found unusable; actual assistive-technology delivery stays the open audit item below, not a release blocker recorded here ([shared-app.md](../validation/shared-app.md), 88 checks per engine).

## Deliverables and interfaces

- Complete shared onboarding, appearance settings, and user-facing storage status.
- Accessibility audit results and repeatable browser/desktop interaction scenarios.

## Acceptance criteria

- [x] A user can bring history and use the local product without creating a Quixi account or enabling semantic search. — No account exists in the product (Quixi Cloud is deferred and the onboarding says so); the onboarding proof finishes setup with "Later" on the semantic step and records that history stays usable without a provider ([onboarding.md](../validation/onboarding.md)); the import panel proof brings a provider export in, opens the conversation and finds it by exact search with no model provisioned ([extension-import.md](../validation/extension-import.md), imports proof, 18 checks per engine); the archive scale proof exports and restores 30,000 messages on a page with no model and no account ([archive-scale.md](../validation/archive-scale.md)).
- [x] Changing a theme does not change interaction preferences or hide required warnings. — the shared-app proof switches through all six themes and asserts, for each, that every interaction preference is unchanged apart from the revision, that the saved-status region stays visible, and that body and muted text keep ≥ 4.5:1 against the page background; alert, status and warning tokens are defined for every theme, including the dark one ([ADR 0039](../decisions/0039-appearance-themes.md)).
- [ ] Core workflows can be completed with keyboard and screen reader, including import, branch selection, switching, and export.
- [x] Persistence and semantic availability are reported from actual capabilities/state rather than hardcoded success indicators. — onboarding step 2 and Storage health read diagnostics, host capabilities, `supportsWasmSimd`, a WebGPU adapter probe and the host model presence; the proof records different WebGPU answers per engine and the refused persistence request.

## Boundaries and sequencing

Accessibility begins in plan 08; this plan completes coverage. Semantic plans extend these screens with indexing controls when available. Cloud enrollment is added only after the deferred Cloud implementation exists.

[Back to the roadmap](./README.md)


## Async panel focus increment — 2026-09-10

[Keyboard focus qualification](../validation/keyboard-focus.md) now covers
preferences, provider settings, import, export and restore in the production
shared application. Disabled controls park focus on a stable heading; re-enabled
controls regain it unless the user moves or explicitly blurs focus. Removed
controls keep a stable destination, and opening an imported conversation focuses
its loaded heading. Import/archive live regions announce phases rather than
changing counters. The same proof fixed ignored export preparation during
initialization and adds explicit cancellation/disposal regressions.

All 51 application groups pass in Chromium and Playwright WebKit; 51 controller
tests and `npm run check` pass, with 88 source hashes verified in the
[aggregate record](../validation/results/keyboard-focus-checks-macos.json).
The accessibility task remains unchecked: [open findings](../validation/accessibility-open-findings.md)
include alias/compaction removal focus, the summary select's visible/accessibility
label mismatch, input-boundary contrast, narrow alias editing and actual
assistive-technology qualification. Completed plan counts do not change.


## Branch and alias review accessibility increment — 2026-09-10

[Review accessibility qualification](../validation/review-accessibility.md)
passes all **54 application groups in each of Chromium and Playwright WebKit**,
31 summary/compaction tests, 12 preference/alias tests and `npm run check`.
The [aggregate record](../validation/results/review-accessibility-checks-macos.json)
verifies 90 source hashes and retains layout/focus reports and screenshots.

Stable review headings now recover keyboard position after alias/fallback and
compaction controls disappear; deliberate blur or movement elsewhere wins.
Fresh-branch stale-scope changes still expire consent. The summary select uses
its visible label and summary counts have a concise atomic status. Measured
input-border contrast and five review/editor layouts pass at 320px and enlarged
text in both engines, including the WebKit native-select overflow correction.

The broader accessibility task remains unchecked. Actual screen-reader output,
compatibility announcements, repeated action context, global recovery focus,
long-name alias application layout and other host/state coverage remain in the
[findings](../validation/accessibility-open-findings.md). Completed plan counts
remain 7 of 23; onboarding and themes remain separate work.


## Action context and workspace recovery increment — 2026-09-10

[Action accessibility](../validation/action-accessibility.md) passes **59 groups
per browser engine**, **97 unit tests** (74 switching, 12 preferences, 11 library)
and `npm run check`. Its [aggregate evidence](../validation/results/action-accessibility-checks-macos.json)
verifies 93 browser source hashes, the additional controller test source and 31
retained artifacts.

Repeated message actions now include speaker/page-position context, fallback
removal names its target, and long-name alias application fits narrow/enlarged
layouts. Compatibility reports retain readable reasons with one settled-outcome
status; unchanged results do not mutate the live text, while changed settings
still invalidate consent. Workspace recovery retains a visible destination and
respects focus moved elsewhere. Unknown outcomes cannot be dismissed before
reconciliation; known refusals dismiss without canonical writes. Integrated
verification fixed the conditional routing hook lifetime and recovery-heading
layout collapse, preserving imported-conversation and pointer navigation.

The accessibility task remains open for actual assistive-technology and wider
host/state evidence. Pending recovery across conversation navigation and search
is the next concrete gap: those operations can clear the ordinary error field
that owns the recovery button. Plan completion remains 7 of 23.
