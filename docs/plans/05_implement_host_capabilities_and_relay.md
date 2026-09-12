# 05 — Implement host capabilities and provider relay

**Status:** In progress — browser and desktop adapters, macOS native HTTP/keychain/files, the relay and the credential boundary have measured evidence and both composition roots inject them; macOS native OAuth and browser OAuth callback runtimes are implemented; other native platforms, live registrations, notifications and release gates stay open

**Workstream:** A3 — host infrastructure

**Depends on:** [02](./02_define_canonical_history.md)

## Outcome

Give the shared application a consistent host boundary for provider transport, credentials, OAuth, files, and OS integrations across desktop and browser deployments.

## Product references

- [6. Deployment architecture](../product.md#6-deployment-architecture)
- [8. Host architecture](../product.md#8-host-architecture)
- [30. Provider adapters](../product.md#30-provider-adapters)
- [35. Privacy classes](../product.md#35-privacy-classes)
- [94. Onboarding](../product.md#94-onboarding)
- [110. Release/platform risks](../product.md#110-releaseplatform-risks)

## Tasks

- [x] Implement HostClient adapters in the web and desktop composition roots. Define supported/unavailable capability reporting so shared UI does not infer privileges from the platform name. Both entries inject the real adapters; capabilities name native files, notifications, OAuth, clipboard, secret persistence and each provider transport with an availability state and reason, and the shared interface reads only those ([browser fixture suite](../../apps/web/tests/README.md), [native host proof](../../tests/hosts/results/tauri-native-host-macos-26.5.2.json), [settings controller tests](../../packages/app/src/features/providers/tests/controller.test.mjs); reviewed 2026-09-10).
- [x] Implement desktop secret storage through the OS keychain and provider HTTP through native commands. Define streaming, cancellation, timeout, error, and OAuth-callback contracts. The macOS keychain and native HTTP pass the [native host proof](../../tests/hosts/results/tauri-native-host-macos-26.5.2.json) across process restart and the [native provider proof](../../tests/hosts/results/tauri-providers-macos-26.6.2.json); the streaming, cancellation, timeout and error contracts are in `HostClient`, and the OAuth-callback contract is defined in [ADR 0005](../decisions/0005-host-capabilities.md#oauth-callbacks) with macOS implemented under [ADR 0025](../decisions/0025-native-oauth-callbacks.md) and browser callbacks under [ADR 0026](../decisions/0026-browser-oauth-callbacks.md); production OAuth capability stays unavailable because registration tables are empty ([native qualification](../validation/native-oauth.md); reviewed 2026-09-10).
- [x] Define browser credential/session handling and disclosure before implementation. Document what is retained locally, what crosses a relay, and how secrets are removed or revoked. [ADR 0005](../decisions/0005-host-capabilities.md#credentials-and-user-disclosure) and [ADR 0011](../decisions/0011-provider-account-setup.md) define memory-only browser credentials, the relay disclosure and removal; the settings interface states them before connection ([panel proof](../../packages/providers/docs/account-setup-validation.md); reviewed 2026-09-10).
- [x] Implement browser direct transport where the provider permits it and a minimal relay for the first supported providers where needed. Define authentication, destination restrictions, stream forwarding, disconnect cancellation, and redacted operational logging. The browser host forwards directly or through the registered relay; the [relay](../../apps/relay/README.md) passes 17 service tests covering principal authentication, destination and route denial, incremental streaming, consumer cancellation disconnecting upstream and redacted diagnostics, plus real browser integration in both engines (reviewed 2026-09-10).
- [x] Keep the relay stateless with respect to user history; document hosted versus self-hosted configuration and the visible privacy class of each transport. The relay holds no history and logs no content; [ADR 0005](../decisions/0005-host-capabilities.md#relay-deployment-and-trust-boundary) and the [relay README](../../apps/relay/README.md) document operator-owned configuration and each privacy class, and the settings interface labels every connection from the host's transport report (reviewed 2026-09-10).
- [ ] Add bounded file import/export integration and desktop deep-link/callback validation. Schedule notifications, pairing hooks, and updater wiring with the features that use them. Bounded file import/export is complete on both hosts ([native file evidence](../decisions/0005-host-capabilities.md#native-file-evidence), [browser disk downloads](../../apps/web/tests/README.md)); macOS installed cold/warm callback admission now passes [native qualification](../validation/native-oauth.md). Other native callback platforms, provider-specific redirect methods and the scheduled OS integrations remain open (reviewed 2026-09-10).
- [x] Provide host contract tests using controlled provider endpoints and fixture files, including unauthorized requests, failed callbacks, and user cancellation. Unauthorized requests and user cancellation are covered by the browser fixture suite, relay tests and native proofs. The [installed OAuth proof](../validation/native-oauth.md) adds failed/mismatched/expired/duplicate callbacks, session loss, cancellation during token exchange and reconciliation after the keychain commit cutoff (21 phases, 219 assertions). The [browser OAuth qualification](../validation/browser-oauth.md) adds real Chromium/WebKit cross-origin navigation, a built callback under COOP/COEP, CORS PKCE exchange and session credential use. This closes the controlled-test task on the measured hosts; other native platforms and live-provider qualification remain separate open gates (reviewed 2026-09-10).

## Deliverables and interfaces

- Browser and desktop HostClient implementations and a minimal independently deployable relay when required by the supported provider path.
- Credential/transport decision record, configuration examples, and shared cancellation/error behavior.

## Acceptance criteria

- [x] Shared provider code streams and cancels through either host adapter without importing Tauri or browser-specific secret storage. The providers package depends only on `HostClient`; the same adapters stream and cancel in the [browser proof](../../packages/providers/tests/results/browser-macos-26.6.2.json) and the [native proof](../../tests/hosts/results/tauri-providers-macos-26.6.2.json) (reviewed 2026-09-10).
- [x] Credentials are absent from application logs, exported archives, and ordinary history records. The relay logs only identifiers and counts ([relay tests](../../apps/relay/tests/relay.test.mjs)); the [shared application acceptance](../validation/shared-app.md) scans every canonical record, every provider request body, both exported archives, browser storage and the rendered document for the connected credential and finds none (2026-09-10).
- [x] A relay request cannot select an arbitrary unrestricted destination, and abandoned streams release their upstream work. Relay tests deny unregistered destinations, routes, methods and query names, and consumer cancellation disconnects the upstream request ([relay tests](../../apps/relay/tests/relay.test.mjs); reviewed 2026-09-10).
- [x] Browser deployments accurately identify direct, Quixi-relay, and self-hosted transport behavior. The browser host reports each transport's kind, privacy class, origin and operator identity; the settings controller labels connections from that report alone and the interface discloses the operator ([settings controller tests](../../packages/app/src/features/providers/tests/controller.test.mjs), [browser fixture suite](../../apps/web/tests/README.md); reviewed 2026-09-10).

Regional native extension (2026-09-10): [US/EU OpenAI connections](../validation/native-regional-connections.md)
now expose exact host-owned processing metadata with distinct credential
bindings. The actual Tauri proof passes 29 checks; shared settings require
credential-bound eligibility and separately gate images. The matching regional
web relay configuration/handshake is now implemented and verified in the
[regional web relay increment](../validation/regional-web-relays.md): exact
operator/configuration admission, separate regional origins, final policy guards,
257 Node tests, nine real-relay app groups and the existing regressions per engine.
The later [integrated native proof](../validation/native-regional-attempts.md) closes
plan 10's constrained-attempt composition gate. It adds no native-platform
qualification beyond the recorded macOS runtime.

## Boundaries and sequencing

The browser adapter passes 30 controlled browser fixture tests (fifteen scenarios per engine). Native HTTP/keychain
checks run across actual macOS Tauri process restarts. The relay passes 26 service
tests, real browser HostClient integration in Chromium/WebKit, and a local
non-root, read-only Docker startup check. [ADR 0005](../decisions/0005-host-capabilities.md)
and the [relay README](../../apps/relay/README.md) record scope and reproduction.
Root commands `npm run test:relay` and `npm run test:relay:browser` reproduce the
service and browser checks; both are included in the frontend CI job.

The macOS native OAuth runtime and installed callback admission are qualified
with synthetic fixtures ([validation](../validation/native-oauth.md)). The
[browser callback flow](../validation/browser-oauth.md) now preserves COOP/COEP
through real Chromium/WebKit navigation. Native external-browser authorization UX,
Windows/Linux delivery, provider-specific loopback redirects, notifications and live provider
registrations remain open. Public relay ingress/proxy validation,
authorization provisioning and limits across multiple relay instances remain
release gates. Local controlled endpoint tests do not establish those gates.

This does not introduce a Cloud archive backend. Browser credential policy is a required design deliverable, not permission to silently persist secrets. Keep platform-specific implementations behind HostClient.

[Back to the roadmap](./README.md)
