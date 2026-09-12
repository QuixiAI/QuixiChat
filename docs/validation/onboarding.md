# First-run onboarding and storage status qualification

Date: 2026-09-12. Plan: [13](../plans/13_complete_onboarding_appearance_and_accessibility.md)
(onboarding and storage-status tasks) and [21](../plans/21_integrate_semantic_and_hybrid_search.md)
(step 5 semantic enrolment). Decision: [ADR 0018 addendum](../decisions/0018-local-preferences-and-routing-presets.md#onboarding-state--2026-09-12).
Retained record: [onboarding-checks-macos.json](results/onboarding-checks-macos.json)
(13 source hashes, `sourceStable: true`).

Environment: macOS 26.6.2 (arm64), Node v22.23.1, Playwright 1.63.0 Chromium
and WebKit, the shared application harness with the production storage worker
and the pinned embedding model served under `/models/`.

## Commands

```sh
npm run test:core                     # 69 tests: v1/v2→v3 preference normalization, onboarding-state validation
npm run test:app:preferences          # 12 controller tests
npm run test:app:onboarding:browser   # shared application, Chromium + WebKit
npm run test:app:browser              # full application proof with the scenario appended
```

## What is implemented

- Product §94 steps 1–5 render inside the library landing on any archive
  whose device-local preferences (ADR 0018 row, now version 3 with
  `onboardingCompletedAt`) have no completion time; the landing's own actions
  stay usable beside them. Older v1/v2 rows normalize to v3 without a write and
  show the steps once, as a fresh device would.
- Step 2 reads actual state: storage diagnostics (backend, schema, integrity,
  usage/quota, the worker's `persisted` observation), host capabilities (native
  files, extension transfers, notifications, the new `persistentStorage`
  capability with its current grant), lexical search status, WASM SIMD support,
  a WebGPU adapter probe and whether the host provides the local model.
- Product §14: "Request persistent storage" calls the new
  `HostClient.requestPersistentStorage` (web: `navigator.storage.persist()`;
  desktop: unavailable with the reason that app-directory storage is not
  browser-evictable) and reports the browser's actual decision.
- Product §13: the same status block (location, database, usage/quota,
  persistence, ownership note, Export backup) also heads the Storage health
  section.
- Step 5 enrols semantic search through the plan 21 controller; Later or
  Finish records completion; Preferences shows when setup finished and can show
  it again.

## Shared application (`npm run test:app:onboarding:browser`)

| Check | Chromium | WebKit |
| --- | --- | --- |
| fresh archive shows step 1 above the usable landing; completion null | pass | pass |
| step 2 reports SQLite WASM/OPFS, FTS5, WASM SIMD, host model, WebGPU and persistence from actual state | WebGPU unavailable (headless), not persisted | WebGPU available, not persisted |
| requesting persistent storage reports the browser's actual answer and re-reads status | not granted (headless profile) | not granted |
| step 3 opens Import history with the extension pairing code; steps resume | pass | pass |
| step 4 reports configured provider connections | pass | pass |
| Later records completion; hidden after a browser restart | pass | pass |
| Preferences shows the setup again; Enable on step 5 enrols semantic search and completes | pass | pass |
| Storage health shows the §13 block and Export backup opens the export section | pass | pass |

Both headless engines refuse the persistence request; the interface shows
"not granted" with the eviction warning rather than a hardcoded success, which
is the §14 behaviour. A granted answer was not observed here because
automated profiles have no engagement signal; a real browser session is the
place to observe it.

## Full application proof (`npm run test:app:browser`)

The complete runner passes **84 checks per engine** (76 plus these 8) in
Chromium and WebKit, retained as
[onboarding-app-macos.json](results/onboarding-app-macos.json). Qualification
found and fixed one regression: awaiting the persistence probe inside every
`capabilities()` read slowed provider-settings updates enough for a controlled
checkbox to revert momentarily; the web host now probes once at start and
after each request, and capability reads stay fast.

## Limits and open gates

- Themes (product §92) and the assistive-technology audit remain plan 13 work.
- The onboarding is not keyboard/screen-reader qualified beyond the shared
  focus conventions; it joins plan 13's accessibility audit.
- Desktop (Tauri) rendering of the steps and its storage-status wording are
  not exercised natively.
