# 08 — Build the shared chat and library experience

**Status:** Complete (2026-09-12) — shared library/chat/import/provider UI, branch navigation, rich rendering with coloured code, usage and health displays, PDF attachments and persisted interaction preferences pass controlled browser acceptance under both providers; keyboard/focus, scalable text (320px at 200% root text), reduced motion, DOM-level screen-reader semantics and controlled streaming announcements are qualified in the shared-app proof (86 checks per engine). Actual assistive-technology delivery, installed screen readers and host-native controls remain plan 13's audit and release qualification.

**Workstream:** A4 — first daily-use interface

**Depends on:** [03](./03_build_storage_repositories.md), [05](./05_implement_host_capabilities_and_relay.md), [06](./06_integrate_live_providers.md), [07](./07_build_shared_chunks_and_fts.md)

## Outcome

Provide a usable shared conversation library and chat interface on web and desktop, with durable history, two providers, branch navigation, and lexical search.

## Product references

- [16. Canonical conversation model](../product.md#16-canonical-conversation-model)
- [17. Message](../product.md#17-message)
- [18. Generation](../product.md#18-generation)
- [19. Content parts](../product.md#19-content-parts)
- [20. Branching](../product.md#20-branching)
- [22. Thread events](../product.md#22-thread-events)
- [29. Core chat experience](../product.md#29-core-chat-experience)
- [31. Typed capabilities](../product.md#31-typed-capabilities)
- [46. Search result UX](../product.md#46-search-result-ux)
- [92. Appearance](../product.md#92-appearance)
- [93. Accessibility](../product.md#93-accessibility)
- [103. Track A — Product Core](../product.md#103-track-a--product-core)
- [107. First usable build](../product.md#107-first-usable-build)

## Tasks

- [x] Select and record the shared UI framework and state-management approach before expanding the scaffold. Keep product features in packages/app and inject storage/host clients at the composition boundary. See [ADR 0009](../decisions/0009-shared-interface-and-state.md).
- [x] Build the paginated thread library with rename, pin, archive, tags, search, and navigation. Render large histories incrementally rather than loading the entire archive into application state. Rename, pin, archive, tags and search are covered by the [shared application acceptance](../validation/shared-app.md); its [scale scenario](../validation/shared-app.md#scale) shows bounded pages and windows over 2,001 conversations and a 2,000-message thread in both engines.
- [x] Build the composer with model/account selection, system prompts, generation settings, attachments, drag/drop, quoting, and keyboard shortcuts derived from supported capabilities. The remaining interaction preferences now pass persistence, failure recovery and two-engine restart qualification ([interaction preferences](../validation/interaction-preferences.md), 46 application groups per engine).
- [x] Implement streaming, stop, retry as a distinct attempt, and durable generation-state rendering. Separate transient presentation state from canonical history.
- [x] Implement edit/regenerate branches and active-path navigation while retaining sibling messages and generation candidates. Regenerate creates a distinct attempt beside the first, editing creates an immutable sibling that keeps the original and its generated descendants, the starting-branch and sibling lists show every alternative at a point, choosing one commits the active path and lists its continuations, the other branch stays intact while another path is active, and a fresh browser process retains the branches and can switch them without a provider ([shared application acceptance](../validation/shared-app.md), reviewed 2026-09-09).
- [x] Render Markdown, LaTeX, code, images, files, citations, tool content, and unsupported-part fallbacks. Treat imported/model content as untrusted display content and preserve access to the original representation. The [content proof](../../packages/app/src/features/content/README.md) covers Markdown, GFM, fenced code coloured by a bounded dependency-free tokenizer for a fixed language set (since 2026-09-09) beside plain unknown languages, bundled LaTeX, blob-backed text, local image preview, missing files, tool source, citations (safe links only), redacted reasoning, structured data, provider artifacts, audio attachments and notes, all inert with the original representation reachable. Code copy now goes through the host clipboard capability with a control shown only when available (2026-09-10); inline audio playback remains a separate open product item (§29).
- [x] Add token/cost displays and visible provider/health badges without assuming metadata is always available. The composer shows the selected connection's health badge with the provider's reason and evidence; each attempt shows reported tokens (with cached tokens when present) and a cost that is either reported by the provider, estimated from the reviewed catalog price and labelled as such, or unknown; the conversation header sums attempts, tokens and priced estimates aggregated by the storage worker over every recorded attempt, naming attempts without a price ([shared application acceptance](../validation/shared-app.md), [usage view tests](../../packages/app/tests/providers/usage.test.ts), [thread usage SQL test](../../packages/storage/tests/canonical/views.test.ts), since 2026-09-09).
- [x] Build keyboard navigation, focus handling, scalable text, reduced motion, screen-reader semantics, and controlled streaming announcements from the first usable UI. — Keyboard navigation and focus handling: [keyboard-focus.md](../validation/keyboard-focus.md), [action-accessibility.md](../validation/action-accessibility.md), [review-accessibility.md](../validation/review-accessibility.md), [pending-recovery.md](../validation/pending-recovery.md). Scalable text: the reviews and the alias editor at 320px and 200% root text, and since 2026-09-12 the conversation library and an open conversation with saved messages in the shared-app proof ([shared-app.md](../validation/shared-app.md), 86 checks per engine). Reduced motion: the stylesheet declares no animations or transitions and a `prefers-reduced-motion` guard disables any later one. Screen-reader semantics: landmarks, names and status regions qualified at the DOM level in those proofs. Controlled streaming announcements: the polite generation status changes exactly twice across a streamed two-part reply (in progress, complete) and no live region exists inside the message list. Actual assistive-technology delivery and installed screen readers remain plan 13's audit and a release gate.

## Current evidence

See [shared application acceptance](../validation/shared-app.md) for actual Chromium/WebKit multi-turn chat, edit/regenerate, stop, search and browser-process reopen; bounded SQL view tests; provider/import/content evidence; and explicit remaining limits. Both ordinary hosts now inject real storage and host services. No complete-plan claim follows from this slice.

The composer now offers temperature, top-p and stop sequences when the reviewed
catalog declares them; [ADR 0011](../decisions/0011-provider-account-setup.md)
records the 2026-09-09 parameter review for both initial models. Sixteen browser
checks per engine cover invalid-setting gating with a retained draft, protocol
field mapping for both adapters, omitted blank settings, per-attempt recorded
values and the tighter Anthropic temperature range after a provider switch.
Quote in reply inserts a selected passage or a whole inline message as a
blockquote, refuses over-limit quotes without altering the draft, and the
quoted text is sent. Image attachments now enter the composer through the host
file picker or drag and drop: each is streamed through the host into a verified
staged blob (bounded to the provider request profile, refused when it is not a
PNG, JPEG, GIF or WebP image, is oversized or is mislabeled), previewed, removable
before sending, and published as an attachment and Image part in the same
commit as the message, then sent as a provider image block; the archived bytes
preview again from the conversation (a nineteenth check per engine, see
[shared application acceptance](../validation/shared-app.md)). PDF files now use
the same picker/drop workflow with original-byte verification, accessible metadata
preview, removal and cancellation. They publish canonical File parts and use the
reviewed provider mappings for inspection/count/send/regeneration; unsupported
formats and regional file inputs are explicitly refused. [ADR 0027](../decisions/0027-composer-file-inputs.md)
records the contract, and [composer-file validation](../validation/composer-files.md)
records 44 passing groups per engine, including restart and portable restore.
That proof exposed and corrected a click reaching the old library during archive
replacement: library navigation and creation now disable until the selected
archive opens. The local settings path and
persisted Enter/Mod+Enter preference now pass worker, failure-recovery and
Chromium/WebKit process-restart proofs ([local preference acceptance](../validation/local-preferences.md),
[ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md), 2026-09-10).
The four remaining interaction settings now use the same worker-owned path:
message timestamps, model badges, comfortable/compact composer layout and
model dropdown/list style. Existing version-1 rows receive compatible defaults
without a write; explicit edits preserve the send-key choice and use revision
checks. The [interaction preference proof](../validation/interaction-preferences.md)
records lost-reply recovery, cross-client conflicts, unchanged drafts/history and
restart in both engines. The broader accessibility audit remains open.

The [scale scenario](../validation/shared-app.md#scale) closes the responsiveness
criterion: 2,001 seeded conversations and a 2,000-message thread through the
production worker, with the cold library, title filter, paging, the latest
window, three older windows, latest again, an exact search and its hit all
served from bounded pages in both engines. It also exposed and fixed a
scheduling defect: the worker ran an indexing slice inline after every
foreground call, so a view load paid one slice per read during background
indexing; maintenance now runs from a short idle timer.

Automatic conversation refresh now waits for active view loads to settle and
coalesces notifications into one follow-up. This fixes a reproduced starvation
case where repeated changes superseded slow reads before they could publish;
explicit navigation remains immediate and stale results/errors are fenced.
Failed parallel message groups retain their refresh slot until all siblings
settle. Nine controller regressions pass (seven fail against the isolated prior
implementation), along with all 44 shared-application groups in both engines
([refresh validation](../validation/library-refresh.md), 2026-09-10).

A seventeenth check per engine drives the core workflow by keyboard only: skip
link, new conversation, send, stop, regenerate, edit/cancel/save, rename and
search-result navigation keep visible focus on a named control, the streamed
messages region is `aria-busy` without a live region, and the status line
announces only at attempt boundaries. Controls that unmount or disable after
activation hand focus to the composer or search field. Scalable text, contrast
and the import/export/provider screens remain for the plan 13 audit.

[Exact conversation search navigation](../../packages/app/src/features/content/tests/search-browser/README.md)
now focuses a matching part beyond the initial bounded parts page without
enumerating preceding pages. Actual filename, text and description hits retain
their own source addressing. Seven browser groups per engine include stale-hit
refusal, narrow layout, canonical/context invariance and drafts typed while a
search lookup is pending; eight controlled tests cover the resolver boundaries.

## Deliverables and interfaces

- Shared library/conversation features and workflow coordination in packages/app.
- A UI technology decision record and browser/desktop end-to-end chat scenarios.

## Acceptance criteria

- [x] A user can create, stream, stop, reopen, edit, regenerate, and search a conversation with either initial provider. Streaming, stop and regenerate are proven under both the OpenAI and the Anthropic connection, text streamed by each is indexed and found by search, and create, reopen and edit involve no provider ([shared application acceptance](../validation/shared-app.md), 2026-09-10).
- [x] Reloading retains branches and committed content; interrupted generations are shown accurately. A fresh browser process reopens the same archive with every message and branch, switches branches without a provider, and shows the stopped attempt with its recorded interrupted status and sealed output ([shared application acceptance](../validation/shared-app.md), 2026-09-09).
- [x] Large thread lists and long conversations remain responsive without archive-wide reads. The [scale scenario](../validation/shared-app.md#scale) seeds 2,001 conversations and a 2,000-message thread through the production worker and shows every library, conversation, paging and search interaction using bounded page reads only, each well inside its budget, after background indexing was made to yield to foreground reads.
- [x] Core workflows are keyboard accessible, and streamed content does not continuously overwhelm screen-reader announcements. Chat/library evidence is in the [shared application acceptance](../validation/shared-app.md); the broader audit of other screens is plan 13.

## Boundaries and sequencing

Provider-switch inspection is plan 10; compare/critique is plan 12. Basic accessibility is required here and is audited more broadly in plan 13. The legacy Gemma UI remains reference material, not a runtime dependency.

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
host/state evidence. This iteration identified pending recovery across navigation
and search as the next gap; the subsequent increment below resolves it.
Plan completion remains 7 of 23.


## Pending recovery through navigation and search — 2026-09-10

[Pending recovery](../validation/pending-recovery.md) passes **60 groups per
engine**, **127 unit tests** and `npm run check`, with 95 matching source hashes.
A dedicated region keeps the original conversation and Check pending change
available through ordinary-error dismissal, thread navigation and lexical search.
Concurrent checks share the exact frozen original batch; a held retry preserves
newer selection/focus, and a failed check remains retryable. The browser proof
captures an actual durable summary write with its reply lost, then verifies no
additional canonical/sync writes or provider traffic from reconciliation.
Known-refusal dismissal and the existing branch recovery remain qualified.
The broad accessibility task stays open for actual assistive-technology and
wider host/state evidence.
