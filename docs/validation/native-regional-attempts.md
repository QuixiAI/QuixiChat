# Integrated native regional attempts

Recorded 2026-09-10 for product §34, plan 10 and
[ADR 0023](../decisions/0023-regional-processing-evidence.md).

## Qualification boundary

The opt-in `quixi-regional-app-proof` binary mounts the shared application with
the production desktop HostClient, provider connections, settings controller,
Storage Worker and native host commands. Production destination registrations
and the application CSP remain unchanged. A separate random UUID identifies the
macOS WKWebsiteDataStore, synthetic archive and Keychain service. Repeated phases
use that UUID in fresh native processes. Cleanup removes its synthetic secrets,
archive and fixture metadata; WebKit may retain profile bookkeeping.

The `regional-app-proof` Cargo feature adds a constructor-only fixture transport.
It preserves the reviewed `https://us.api.openai.com` and
`https://eu.api.openai.com` URLs, Host headers and TLS server names, resolving
their TCP connections to an ephemeral loopback TLS server and trusting its
temporary CA. The pinned reqwest 0.13.4 resolver supports this port override for
URLs without an explicit port. Ordinary certificate and hostname verification,
disabled proxies, refused redirects and disabled retries remain in force.
Non-reviewed destinations are refused in fixture mode before HTTP. Production
JSON, environment configuration and default host construction cannot activate
the injection; production registrations are not rewritten.

The fixture records bounded request metadata, body hashes and credential-match
booleans. It never retains authorization values or raw request bodies. Only
synthetic content and synthetic credentials are used. The proof establishes
the application and host's routing behavior; it cannot establish physical
provider geography, live account eligibility or factual summary quality.

## Reproduction and evidence

Run `npm run test:app:regional:native` on macOS 14 or later with the pinned
dependencies installed. The runner typechecks the driver, builds its separate
frontend and native binary, and retains source/binary/bundle hashes, native
phase exits, checkpoints, actual TLS observations and prior attempts. The
desktop CI workflow includes the command; no remote CI run is implied.

The [native report](../../tests/hosts/regional-app-proof/evidence/native-regional-app.json)
passes **63 checks across five native processes** on macOS 26.6.2 arm64,
system WebKit 21624.5.1.11.3. All 52 recorded source hashes match the delivered
files. The [check report](results/native-regional-attempts-checks-macos.json)
retains five passing Rust tests, `cargo check --locked --workspace` and
`npm run check` (SQLite verification, TypeScript and both frontend builds).
The runner also typechecks and builds the separate native proof. Existing
frontend bundle-size advisories remain non-fatal.

| Native phase | Checks | Actual HTTP |
| --- | ---: | ---: |
| Untrusted CA | 5 | 0 |
| Wrong certificate hostname | 5 | 0 |
| Shared application workflows | 32 | 8 |
| Process restart | 13 | 0 |
| Scoped cleanup | 8 | 0 |

Both TLS negatives use the real native US request path and observe its TLS
server name before the client rejects the certificate. The successful path
observes one model request in each region, five US content requests and one
EU content request. Every request retains the exact regional Host/SNI, method,
path and expected synthetic Keychain credential. No request goes to the global
connection. The five successful content requests cover two US sends, a US
summary proposal, US regeneration and an EU send; the sixth is an intentional
US 503 failure. Its disallowed EU/global fallbacks create no extra request.

The actual Providers panel proves that credential storage and model discovery
cannot confirm eligibility. Text confirmation leaves image eligibility unset.
Unknown and wrong-region initial selections refuse keyboard sends and explicit
counts without creating messages or attempts. Later eligibility revocation
also refuses a new attempt. OpenAI Chat Completions has no implemented token
count endpoint; the proof does not claim a successful provider count.

One explicitly negative scheduling wrapper intercepts a fully staged request,
commits a fresh canonical US-to-EU policy change, then calls the original
desktop HostClient with its unchanged `beforeDispatch` callback. The production
callback refuses before native HTTP. The wrapper is removed in `finally`;
all positive requests use the unmodified host. This establishes the desktop
callback composition without changing production policy or admission behavior.

Seven canonical attempts remain: five complete, the server failure, and the
late-policy failure. Every attempt retains its matching native regional review
basis. The summary's saved input SHA-256 matches exactly one successful TLS
request, while original messages/parts remain byte-for-byte unchanged and the
summary does not become the ordinary transcript branch. A fresh native process
preserves the fingerprint of policies, contexts, messages, parts, attempts,
proposals, events and raw-object records. Keychain credentials reopen, but text
and image eligibility remain unconfirmed; attempted sends create no new HTTP
or canonical attempts. Cleanup verifies that all four synthetic credential
bindings are absent and removes the isolated archive/checkpoint.

Earlier failed attempts remain in the runner's `evidence/attempts/` directory.
They exposed proof-harness errors: the native command requires the `main`
window label, and ordinary provider selection need not create a canonical
primary. The harness now honors both rules. Its exit handling also preserves
requested failure codes after Tauri cleanup, compensating for the pinned Wry
runtime's zero-code `ControlFlow::Exit` path. No product behavior was loosened.

## Acceptance assessment

This closes the integrated native composition gap in ADR 0023. Plan 10 task 1
is now checked against the combined matrix:

| Requirement | Evidence |
| --- | --- |
| Reviewed bindings, model/modality and session eligibility | [Native connections](native-regional-connections.md), native phases above |
| Unknown/wrong/stale region and policy refusal | [Conversation policies](processing-region-policies.md), native initial/late-policy/revocation cases |
| Relay identity and regional upstream agreement | [Actual web relay proof](regional-web-relays.md) |
| Ordered routing, fallback, count/regeneration/summary guards | [Policy regression](processing-region-policies.md), [web relay regression](regional-web-relays.md), native workflows above |
| Compatibility, cost, aliases, versioning and portable restore | [Cost limits](request-cost-limits.md), [aliases](routing-aliases.md), [policy persistence](processing-region-policies.md) |
| Local history after credential loss and restart provenance | Browser regressions and native restart above |

Prior reports keep their historical hashes and original scope; they are not
represented as new runs. This iteration changes no production JavaScript and
adds only feature-gated native fixture transport plus qualification tooling.
No numbered plan is complete: plan 10 task 5 still requires actual summary
fidelity runs (zero scored so far). Other native platforms, release packaging,
scale, real account eligibility and physical geography remain separate gates.
