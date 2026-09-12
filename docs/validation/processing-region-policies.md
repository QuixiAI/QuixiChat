# Conversation processing-region constraints

Recorded 2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. Product §34 / plan 10,
[ADR 0023](../decisions/0023-regional-processing-evidence.md). All request data and
responses are synthetic and use loopback; no paid or private-history request.

This is the retained conversation-policy iteration. The later
[web relay validation](regional-web-relays.md) implements regional relay
configuration/dispatch and contains current regressions; these reports keep
their historical source hashes.

## Delivered behavior

Conversations and reusable aliases can require United States or Europe
(EEA plus Switzerland) processing of submitted content. The requirement covers
counting, ordinary generation, regeneration, every fallback and summaries.
The shared evaluator accepts only exact reviewed native binding/model evidence.
Unknown/global destinations and the other region are refused visibly. Current
credential eligibility and separate image approval remain enforced by the
[native connection controller and adapter](native-regional-connections.md).

The requirement is closed and optional. Profiles containing it use version 5;
versions 1–4 reject the field and retain their previous meanings. Alias application
copies the reviewed profile, so later alias edits do not change a conversation.
Fresh branches, process restart and portable restore preserve the policy.
Schema 12 and archive protocol 4 remain unchanged; policy/audit data stays in
existing canonical JSON fields, while credentials and eligibility stay local.

Initial routing skips disallowed candidates. Direct workflow calls independently
refuse them before attempt creation or provider request staging/dispatch. Fallback
must satisfy both the originating and current region requirement. Generation
compatibility notes and route reasons retain the region and review identity.
Historical regional identity remains distinct from global OpenAI after a regional
connection is removed, preserving destination-change review.

Count and summary controls use the explicitly selected connection. A disallowed
selection explains its refusal; it does not silently send to another connection
for counting. The supported OpenAI Chat Completions adapter still has no token
count implementation. Local summary preparation can display the target decision,
but count/generation cannot transmit a refused request.

Attempt creation has an atomic expected thread revision. After asynchronous body
staging, the final dispatch callback rereads canonical context and exact routing
policy, checks originating/current requirements and unchanged regional evidence,
and rechecks adapter eligibility. Changed policies, including tightened cost caps,
require fresh review. Count results also check the canonical revision/profile
before display or cache insertion. Summary reviews bind the exact policy JSON,
source scope, prepared body and evidence. Pending creation recovery preserves
the original batch and revision assertion.

## Verification

[Unit/build report](results/processing-region-unit-macos.json):

| Command | Result |
| --- | --- |
| `npm run test:core` | 57 passed |
| `npm run test:storage:canonical` | 54 passed |
| `npm run test:providers` | 39 passed |
| `npm run test:app:switching` | 66 passed |
| `npm run test:app:summaries` | 31 passed |
| `npm run test:app:preferences` | 8 passed |
| `npm run test:app:providers` | 13 passed |
| `npm run check` | SQLite verification, typecheck and both frontend builds passed |

These **268 Node tests** include strict old/new profile parsing, positive US/EU
assessment, wrong binding/account/model/protocol/review scope, stale policy and
connection evidence, revoked eligibility, original/current fallback constraints,
summary timing, pre-HTTP staging cancellation, atomic revision conflict and exact
unknown-outcome replay. Workflow fixtures that stop at a commit sentinel prove
pre-write approval/refusal only; successful HTTP is established separately below.

The [application report](results/processing-region-app-macos.json) records
**42 groups in each of actual Chromium and Playwright WebKit**. It uses the real
shared app, settings controller, provider adapters, browser HostClient, Storage
Worker and OPFS archive. Regional native capabilities are explicitly injected
fixtures and requests are routed to a controlled loopback server. The three added
groups prove:

- A US requirement rejects the unknown primary's count without HTTP/write,
  skips unknown/global and EU candidates, and sends through the configured US
  binding with the exact reviewed model. Route/attempt records retain the basis.
- A wrong-target summary is refused; the US summary and regeneration succeed.
  A forced US failure cannot fall back to the configured global/EU targets.
  Four regional generation requests are observed: initial, summary, regeneration
  and failed primary. No disallowed count or fallback request occurs.
- A version-5 alias snapshot remains US after its reusable alias changes to EU.
  The policy, fresh empty branch, exact attempt IDs and audit events survive a
  full browser process restart without configured credentials. Local history and
  original branches remain usable.

All preceding cost, summary, branching, alias, image, provider-switch, search and
recovery application scenarios rerun in the same report. The separate
[settings report](results/processing-region-settings-macos.json) passes **11 groups
per engine**, including confirmation lifetime, revocation and regional image
approval. The [portable report](../../packages/storage/tests/archives/results/snapshot-browser.json)
passes both engine snapshots after **13 archive Node tests**. It retains exact
version-5 policy with both cost limits, summary/fresh-branch records and sync
operations across restore.

The unit/build, app, settings and portable reports record respectively 95, 68,
13 and 24 source hashes, checked against the delivered files. Preceding dated
reports keep their historical source hashes. The expanded
[summary review](results/regions-chromium-summary.png),
[route](results/regions-chromium-route.png) and
[390-pixel restart](results/regions-webkit-mobile.png) screenshots were inspected;
controls and policy/audit text fit their viewports.

## Remaining gates and limits

Regional web relays are implemented by the later [web increment](regional-web-relays.md).
A global/unknown web route still cannot satisfy a configured region requirement.
Plan 10 task 1 remains open for the integrated native constrained-attempt gate in
ADR 0023; the current native proof separates registry metadata from loopback dispatch.

Browser injection proves app/controller/wire/persistence behavior. The preceding
native proof separately exercises actual Tauri WebView, unchanged production
registrations and explicitly non-regional loopback dispatch. Neither proves
physical provider geography, actual provider-account eligibility, other native
platforms or release-scale qualification. No additional same-region account is
invented to claim a positive post-failure fallback; this fixture proves permitted
initial routing and disallowed post-failure fallback. Actual summary fidelity still
has zero scored model runs. No numbered plan or overall implementation goal is
marked complete.
