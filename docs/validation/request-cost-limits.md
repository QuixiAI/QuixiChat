# Per-attempt request-cost limits

2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. Product §34 / plan 10,
[ADR 0022](../decisions/0022-per-attempt-request-cost.md). Synthetic data and
loopback provider responses only; no paid request or private-history transmission.

The reports below retain this iteration's historical source hashes. The later
[processing-region validation](processing-region-policies.md) reruns these cost
scenarios with the current workflow and version-5 regional profiles.

## Delivered behavior

Conversations and reusable aliases have a separate maximum estimated request
cost per attempt in USD. It includes input plus the selected maximum output.
The older input-only limit remains independently editable and enforceable.
Both are preserved when an alias is reviewed/applied or a portable archive is
restored. New profiles use version 4 so an older profile reader refuses them;
invalid requirements and total caps under older versions are not silently dropped.
Schema 12 and archive protocol 4 remain unchanged.

Routing, send, regeneration, fallback and summary generation assess the same
limits. Without a matching count they budget the full declared context window
for input. An explicit count can provide a tighter estimate. Missing or malformed
USD prices and unavailable input evidence refuse capped generation. Input plus
maximum output uses exact decimal arithmetic with upward nano-USD rounding;
no cache discount is assumed. There is no automatic count call or automatic
increase to the configured limit. Invalid draft limits preserve the saved value
and keep generation disabled until corrected.

The chat controller caches at most 16 counts by adapter identity, model and hash
of the exact prepared generation body. No prompt text or image bytes are retained
in the cache, and it does not survive controller disposal/restart. Draft, system,
image, history, model, connection or generation-setting changes cannot reuse a
nonmatching count. Late cancelled/stale counts cannot authorize generation.

The workflow checks before publishing the user turn or starting regeneration,
independently of UI routing. A fallback has its own request/model assessment and
obeys both the originating and current limits. Its event records the assessment
basis. A summary uses its own reviewed request and count, and checks before
freezing/staging input or creating an attempt. Its review also now displays the
available input/output prices correctly: non-cached estimates explicitly supply
zero cached usage rather than treating those fields as unknown.

## Verification

[Unit/build report](results/request-cost-unit-macos.json):

| Command | Result |
| --- | --- |
| `npm run test:core` | 56 passed |
| `npm run test:storage:canonical` | 54 passed |
| `npm run test:providers` | 32 passed |
| `npm run test:app:switching` | 51 passed |
| `npm run test:app:summaries` | 24 passed |
| `npm run test:app:preferences` | 8 passed |
| `npm run test:storage:archives` | 13 Node tests and both actual snapshot proofs passed |
| `npm run check` | SQLite verification, typecheck, web and desktop frontend builds passed |

The **225 affected Node tests**, plus 13 archive tests, cover exact decimal/equality
boundaries, upward rounding, invalid/unknown pricing and currencies, zero limits,
legacy and total limits independently, strict version parsing, immutable alias
snapshots, count-cache eviction, stale/cancelled counts, and pre-commit refusal
when a caller bypasses the UI. Tests capture identical prepared wire bodies
across newly allocated canonical IDs. Unit tests that stop at a commit or staging
sentinel do not claim successful provider dispatch; the browser proof covers it.

[Shared application report](results/request-cost-app-macos.json): **39 groups in
each of actual Chromium and Playwright WebKit**, with the real shared app,
production host/adapters, Storage Worker and OPFS archive. The new scenario proves:

- A tight total cap blocks keyboard/button sends without messages, generation
  writes, provider generation HTTP or an implicit count.
- Explicit counting unlocks the matching request. Invalid cap input preserves
  the saved limit and disables generation; draft/output edits expire the displayed
  count. The actual primary body agrees with the counted message content and cap.
- A counted primary may run while its over-budget fallback gets neither a
  generation request nor a hidden count call.
- Summary generation independently blocks on its conservative budget, then
  explicit reviewed counting unlocks it with consistent visible price estimates.
- A sufficient conservative budget permits primary/fallback/regeneration with
  the selected output cap and no implicit counts. The fallback event names its
  cost basis.
- The alias editor and explicit application review persist the new total cap;
  the exact version-4 profile and fallback cost evidence survive process restart
  without configured providers and fit the narrow viewport.

Visual evidence: [Chromium route](results/request-cost-chromium-route.png),
[Chromium summary](results/request-cost-chromium-summary.png),
[Chromium mobile](results/request-cost-chromium-mobile.png),
[WebKit route](results/request-cost-webkit-route.png),
[WebKit summary](results/request-cost-webkit-summary.png),
[WebKit mobile](results/request-cost-webkit-mobile.png).

The [portable report](../../packages/storage/tests/archives/results/snapshot-browser.json)
restores version-4 routing with an input cap of 0.25 and a total cap of 0.5,
together with the existing summary/fresh-branch records, exact journal and empty
selection in both engines. An initial fixture assertion compared JSON property
order instead of canonical content; the corrected canonical comparison passes.
The retained reports capture matching implementation-source hashes. Earlier
branch/summary reports remain historical records of their captured revisions;
all their shared-application checks were rerun here.

## Practical limits and remaining gates

These are estimates using dated reviewed rates, not invoice ceilings. Provider
counts may differ from billed usage, and regional/account/service pricing can
differ from the configured catalog. Each attempt has its own limit; retries and
summary requests can incur additional charges. An absent count can cause a
conservative refusal even when a short request would fit. After restart, an exact
chat count must be obtained again to use that tighter estimate. Regeneration can
reuse only an identical cached request; otherwise it uses the context budget.

Official pricing, token-count semantics and output limits were checked and cited
in [ADR 0022](../decisions/0022-per-attempt-request-cost.md). This proof does not
qualify paid-provider billing, summary fidelity, installed Safari, native Tauri
or other operating systems. Region requirements and actual model fidelity remain
open in plan 10; the broader implementation goal remains active.

Subsequent verification (2026-09-10): the [provider-capability correction](provider-capability-review.md) reran all 39 application groups per engine with the same cost behavior. Reports linked above retain the historical source hashes captured for the cost iteration.
