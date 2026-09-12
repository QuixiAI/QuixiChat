# Native regional OpenAI connections

Recorded 2026-09-10. This iteration implements the positive native connection
prerequisite from [ADR 0023](../decisions/0023-regional-processing-evidence.md).
This is the retained connection-setup iteration. The subsequent
[conversation-policy validation](processing-region-policies.md) adds explicit
region requirements and fallback guards. The later [web relay increment](regional-web-relays.md)
implements authenticated regional relay dispatch. The subsequent
[integrated native proof](native-regional-attempts.md) qualifies constrained
attempts through the unchanged regional HTTPS registration.
Selecting a regional connection by itself still does not constrain other fallback
targets; that requires the conversation policy.

Its reports preserve the source hashes from that iteration. The later policy
validation contains the current app/provider regressions; native registrations
were unchanged.

## Delivered behavior

The desktop Providers panel now offers OpenAI US and Europe (EEA plus
Switzerland) beside the existing global connections. Each has a separate stable
connection, transport and credential-destination binding. The native registry
fixes the exact HTTPS origin and allowed model-list/chat routes. Requests cannot
supply a different origin. Host capabilities carry dated processing evidence
only when the actual registration matches the reviewed origin, binding,
authentication scheme and complete route set.

The provider package validates that evidence against the reviewed model, endpoint
and input scope. The settings controller also checks its selected catalog.
Missing, altered, ambiguous or mismatched evidence disables the connection.
A regional host declaration without the matching application configuration also
refuses, closing a bypass found during review. Labels, privacy classes, arbitrary
regional-looking hostnames and client-side relay declarations cannot establish
a regional connection.

A connected key is not published to chat until the user confirms regional
eligibility. Model discovery cannot grant that confirmation. Text and retained
tool records become usable after the first confirmation; images require a
separate choice and otherwise remain unsupported in the effective adapter
capabilities. Providers identifies this as user confirmation, links the dated
provider requirements, permits eligible Global-project keys and explains the
session lifetime. Credential contents remain in the host's existing secret
boundary. No confirmation or secret is written to canonical history.

Confirmations bind to the opaque credential and exact host configuration.
Reopen, replacement, disconnect, session restart or invalidated evidence clears
them. Changing confirmation replaces the adapter, invalidating retained
prepare/count/stream references and existing adapter-bound count caches.
A final check at HTTP dispatch refuses a request whose eligibility changed after
body staging began. Already-transmitted content cannot be retracted, as the UI
states. The native registry is immutable during the process; another build or
process requires fresh confirmation.

Current model prices are retained; the regional review does not add a blanket
uplift to the existing snapshot. There is no new model, Anthropic parameter,
canonical profile field, schema migration or archive-protocol change in this
connection slice. The later [policy increment](processing-region-policies.md)
implements alias/profile requirements and regional fallback audit data.

## Executed evidence

| Check | Result |
| --- | --- |
| `npm run test:core` | 56 passed |
| `npm run test:providers` | 34 passed, including strict regional evidence/refusal cases |
| `npm run test:app:providers` | 13 passed, including stale adapters and revocation during staging |
| Native Cargo tests | 3 passed, including exact registrations and 15 evidence-invalidating mutations |
| Desktop proof TypeScript check | Passed |
| Native regional proof | 29 actual Tauri WebView checks; 4 synthetic HTTP requests; Keychain cleanup succeeded |
| `npm run test:app:providers:browser` | 11 groups and exactly 11 synthetic HTTP requests in each of Chromium/WebKit |
| `npm run test:app:browser` | 39 groups in each of Chromium/WebKit |
| `npm run check` | SQLite verification, typecheck and both frontend builds passed |

[Unit/build report](results/native-regional-unit-macos.json),
[settings browser report](results/native-regional-settings-macos.json),
[application report](results/native-regional-app-macos.json), and
[native report](../../tests/hosts/results/tauri-native-regions-macos-26.6.2.json)
retain the environment, commands/checks and source hashes. The native report
contains its exact Cargo, TypeScript and runner commands. All recorded hashes
were compared with final runtime/test sources. Earlier capability/cost reports
remain historical captures. The existing build-size advisory is not an error.

The native proof runs inside the actual bundled macOS Tauri WebView. It compares
unchanged production registrations with their expected metadata, then exercises
separately identified loopback registrations for US/EU-shaped credential
bindings. Modified loopback registrations explicitly have **no** regional
evidence. Native HTTP dispatch, wrong/cross-region credentials, wrong account,
method, endpoint, absolute URL and cleanup are exercised. The proof does not
send requests to OpenAI or establish physical location or account eligibility.

The settings browser proof uses the real React component/controller, provider
adapters and production browser HostClient with synthetic native capability
declarations. Those declarations are marked as fixtures. It checks explicit
eligibility, exact regional binding/model at the host boundary, text and image
wire behavior, revocation, replacement/reopen, metadata mismatch, reload and
layout. It is not a substitute for the separate native proof. The complete
application proof reruns existing canonical persistence, aliases, cost,
compaction and restart behavior with its existing controlled connections; it
does not qualify a conversation-wide regional policy.

Focused [desktop](results/native-regional-chromium-desktop.png) and
[390-pixel mobile](results/native-regional-webkit-mobile.png) screenshots show
the expanded EU settings fixture. Both were visually inspected. Their displayed
provider origin is injected test metadata; actual requests use loopback.

## Remaining work

The reviewed profile/alias requirement, shared workflow guards and canonical
persistence are now implemented in the [policy increment](processing-region-policies.md).
Regional web connections now have matching relay/upstream identity checks
([validation](regional-web-relays.md)). The later [integrated native proof](native-regional-attempts.md) closes the full
constrained-app composition gate using the unchanged regional HTTPS registration;
this historical report separately exercises metadata and loopback dispatch. Unknown regions refuse
a configured policy without disabling local history/import/search/export.

The native proof is limited to macOS 26.6.2 and its measured WebKit build. No
real provider request, billing/eligibility verification, private-data
transmission, other native platform qualification, packaging release or
publication occurred. Summary fidelity still has zero scored model runs.
Plan 10 task 1 was open at this connection-only increment; the later native
attempt validation closes it. The broader goal and summary fidelity remain open.
