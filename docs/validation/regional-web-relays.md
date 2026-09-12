# Regional web relay configuration and dispatch

Recorded 2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. Product §34 / plan 10,
[ADR 0023](../decisions/0023-regional-processing-evidence.md). Tests use synthetic
credentials/content, a real local relay and controlled TLS upstreams. No live
provider account, paid request, private-history transmission or deployment.

## Delivered behavior

Operator configuration can add US/Europe relay connections beside ordinary
global connections. Each has a distinct host/credential binding and can specify
its own HTTPS origin, operator and remote privacy class. This permits separate US
and European relay operators in one app. A bad build configuration preserves
local history access and publishes no usable live route.

The server declares its processing region and exact OpenAI upstream registration.
Regional configuration accepts only the reviewed regional HTTPS origin, model-list
GET and Chat Completions POST routes, and required Bearer credential scheme.
Its SHA-256 configuration identity covers the normalized operator, region,
destination, routes and credential scheme. Tokens, principal hashes and rate
limits do not enter the identity. Operators provision that public identity in the
web configuration using the [documented helper](../../apps/relay/README.md#regional-declaration-and-provisioning).

The host authenticates a content-free metadata request during admission and again
before provider dispatch. It accepts an exact bounded declaration matching the
reviewed operator, region, upstream, destination and identity. The metadata call
sends only relay authorization and destination identity, never the provider secret
or conversation content. Responses are bounded to 4 KiB/ten seconds, reject
redirects and fail closed. The forwarding request carries the reviewed identity;
the relay refuses a missing/stale identity before body reads, DNS or upstream
connection. Regional and ordinary routes cannot exchange these identities.
Browser cache/priority headers are permitted as transport metadata and stripped
upstream; provider credentials and content remain forbidden on the metadata path.

The host rechecks the workflow’s local policy after asynchronous relay verification,
immediately before content fetch. The callback stays local and is never serialized
to a relay or native bridge. This closes the gap where another client could tighten
the canonical region while the handshake was waiting. Already-created attempts
remain inspectable as failures when a late policy or declaration change refuses
dispatch; no conversation content is transmitted in that case.

Session authorization replacement cancels pending checks and requests. Per-target
revision counters prevent an older asynchronous replacement from restoring a
cleared token, and late capability results cannot advertise obsolete authorization.
Returned capabilities are deep copies; mutating them cannot redirect a private
registry’s credential-bearing handshake. Disposal cancels work and masks stale
admission. Account and regional image eligibility remain separate explicit user
confirmations, never inferred from model discovery or relay metadata.

The shared evaluator accepts relay evidence only with matching reviewed upstream
facts, exact binding and a remote relay privacy class. It preserves existing
native evidence validation. Historical regional relay attempts use distinct
connection identities from direct native attempts, including after disconnection.
Exact historical remote privacy is unknown unless the matching connection is
configured, so history cannot grant new transport permission.

## Verification

The [unit/build report](results/regional-relay-unit-macos.json) records **257
Node tests** and `npm run check` passing:

| Suite | Passed |
| --- | ---: |
| Core contracts | 57 |
| Provider adapters | 42 |
| App routing/switching | 68 |
| Provider settings controller | 15 |
| Summary controller/source | 31 |
| Preferences/aliases | 8 |
| Regional browser-host protocol/lifecycle | 10 |
| Relay service | 26 |

The new regional host and app proof commands are included in frontend CI; no
remote CI run or deployment was triggered by this local iteration.

The same report retains the ordinary relay browser regression: seven checks in
each engine. The [ordinary host report](results/regional-relay-host-macos.json)
records 30 tests, fifteen per engine. Actual Chromium and Playwright WebKit run:

- [Real relay application](results/regional-relay-app-macos.json): **9 groups
  per engine**, 37 source hashes.
- [Shared application regression](results/regional-relay-regression-macos.json):
  **42 groups per engine**, 71 source hashes.
- [Provider settings](results/regional-relay-settings-macos.json): **11 groups
  per engine**, 16 source hashes.

The unit/build report captures 114 sources and the ordinary host report ten.
All retained hashes were compared with the delivered files. Previous iteration
reports preserve historical source hashes. The desktop bridge’s local callback
was typechecked and frontend-built at this increment; its later integrated
native execution is qualified in [native attempt validation](native-regional-attempts.md).

Node coverage includes exact native/relay metadata, malformed operator/configuration
refusal, US/EU identities and binding/account/model scope, session eligibility,
strict response bounds, cancellation during a held response, token replacement
ordering, stale capability admission/disposal, and the final policy callback.
Actual service tests cover authenticated empty metadata, CORS/rate/destination
controls, unknown/stale identities with zero upstream access, exact US/EU TLS
hostname verification, permitted forwarding and stripped headers. Existing relay
SSRF, TLS, timeout, upload/response and cancellation tests also rerun.

The focused browser proof uses unmodified production composition, web host,
provider/settings controllers, AppRoot, Storage Worker and OPFS archive. The relay
runs its real configuration parser and forwarding service. Its upstream retains
the exact regional hostname and verifies an ephemeral fixture CA. Browser trust
relaxation applies only to the self-signed test relay front end. Negative cases
explicitly alter metadata in that front end; successful declarations are untouched.

It verifies admission, separate account eligibility, isolated returned capabilities,
real model discovery, sends/regeneration/summary with durable attempt records and
exact frozen-input bytes, wrong identity/region/upstream refusal, fresh final checks,
and a process restart without credentials. A held successful metadata response
allows another canonical write to tighten US to Europe; release then produces a
failed attempt with no additional content dispatch. Each engine observes one
model-list request and four content requests upstream (two sends, regeneration
and summary), four complete attempts and two failed attempts from late declaration
and policy changes. Initial identity/region/upstream mismatches each produce zero
content dispatch. The [desktop connection](results/regional-relay-chromium-connection.png)
and [390-pixel restart](results/regional-relay-webkit-mobile.png) screenshots were
visually inspected; controls, region policy and history fit their viewports. The main regression repeats region
routing/refused fallback, alias snapshots, counts, summaries, fresh branches and
persistence alongside ordinary chat/search/import workflows. Settings and ordinary
host/relay browser suites retain their separate scopes.

## Outstanding qualification

This report records the regional web relay implementation increment. Its remaining
native composition gate is now closed by the [integrated native proof](native-regional-attempts.md):
actual Tauri AppRoot/controller/storage attempts through unchanged regional HTTPS
registrations, with hostname-verified synthetic TLS and durable constrained
send/regeneration/summary and refusal evidence. Plan 10 task 1 is checked against
the combined ADR 0023 matrix. These web reports retain their historical hashes
and original scope; no new browser run is implied by the native qualification.

Relay declarations establish agreement with the operator’s reviewed configuration,
not independent physical geolocation, live account eligibility, retention or data
at rest. Public deployment, other native platforms, packaging/scale gates and
actual summary fidelity remain separate. No additional numbered plan or the overall
goal is marked complete by this iteration.
