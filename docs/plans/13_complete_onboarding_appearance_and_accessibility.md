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
- [ ] Complete import and compatibility warning review, recoverable error states, empty states, and progress/cancellation presentation across the application.
- [ ] Implement Warm Reading, Cool Minimal, Compact Ops, Terminal, Bubbles, and Focus themes through shared appearance tokens and layouts.
- [x] Keep interaction settings independent of themes: send-key behavior, timestamps, model badges, composer layout, and model-switcher style. Persist preferences through the agreed local settings path.

  Complete for the interaction settings (2026-09-10): [ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md)
  defines the version-2 worker-owned local row, compatible version-1 defaults,
  conditional revisions and separate routing-alias record. All five choices are
  implemented. [Interaction preference qualification](../validation/interaction-preferences.md)
  covers controller/storage failures, stale views, unchanged drafts and canonical
  history, both layouts, dropdown/list models, and process restart in both engines
  (46 application groups each). Themes remain a separate task; their independence
  acceptance criterion below is not claimed before they exist.
- [ ] Audit keyboard navigation, focus restoration, contrast, screen-reader labels, scalable text, reduced motion, non-color status, and streaming announcements across all completed workflows.
- [ ] Test narrow windows, large text, long titles/content, missing metadata, offline states, and ungranted persistent storage. Record remaining accessibility defects as release blockers where core flows are unusable.

## Deliverables and interfaces

- Complete shared onboarding, appearance settings, and user-facing storage status.
- Accessibility audit results and repeatable browser/desktop interaction scenarios.

## Acceptance criteria

- [ ] A user can bring history and use the local product without creating a Quixi account or enabling semantic search.
- [ ] Changing a theme does not change interaction preferences or hide required warnings.
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
