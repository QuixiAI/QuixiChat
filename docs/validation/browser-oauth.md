# Browser OAuth callback qualification

Date: 2026-09-10

Policy: [ADR 0026](../decisions/0026-browser-oauth-callbacks.md).
Plan: [05 — Host capabilities](../plans/05_implement_host_capabilities_and_relay.md).

## Delivered behavior

The browser HostClient now implements registered authorization-code OAuth with
PKCE S256, exact issuer/state/redirect admission, bounded CORS token exchange and
an opaque session credential. It opens the authorization window during the user's
gesture, nulls its opener and navigates through an explicit no-referrer link.
The built `/oauth/callback.html` returns only a bounded authorization response
over its transaction-specific BroadcastChannel, clears its URL and tells the
user to return to the original application for the result.

The original session keeps state, verifier and credentials in memory. Cancellation,
disposal, pagehide and manual binding mutations prevent late token publication.
Manual credential replacement now checks/removes/inserts synchronously, fixing an
existing window where a competing new credential could occupy the same binding.
Back/forward-cache suspension clears credentials and cancels work; a restored
document cannot resume admission until pending transfer starts and cleanup finish.
Failed cleanup leaves it unavailable. A real unload still closes the host.

The production OAuth registry remains empty. This implements a host capability
and its callback page without enabling an unregistered provider login. Existing
API-key connections keep their session policy. Direct Bearer bindings only are
eligible; public-client registration, exact issuer responses and token/resource
CORS need provider-specific qualification before enablement.

## Reproduction and environment

```sh
npm run test:host:oauth:web
npm run test:host:web
npm run test:host:regional
npm run test:app:browser
npm run check
python3 tests/hosts/browser-oauth-deployment.py --image quixi-storage-proof:local
```

The final command uses an already-cached local nginx image, mounts the built web
directory and production nginx configuration read-only, binds an ephemeral
loopback port and removes its own container. Supply another already-local nginx
image where that fixture image is absent; it does not pull or publish images.

The OAuth browser fixture builds its main test entry and uses the real built
production callback. It runs isolated persistent Chromium and Playwright WebKit
contexts, with synthetic authorization and resource servers on distinct loopback
origins. Successful flows use actual click, popup, cross-origin navigation,
same-origin return, BroadcastChannel, CORS fetch and bearer-resource requests.
Fault injection is limited to explicitly named negative cases and unit seams.
Wire observations retain validity flags, counts and operational metadata rather
than raw authorization codes, states, verifiers or tokens.

## Evidence

The [browser report](./results/browser-oauth-macos.json) passes **44 groups: 22
each in Chromium 153.0.8010.12 and Playwright WebKit 26.6**, on macOS 26.6.2 arm64.
Each engine records 24 authorization navigations, 14 token POSTs and 8 authenticated
resource requests across the scenarios. All 57 recorded source hashes match the
qualified source snapshot, and the runner detects no sensitive output. Main-page
headers match production COOP/COEP without an extra referrer policy; the popup's
explicit no-referrer navigation supplies that protection.

The **12 unit groups** exercise real host/WebOAuth code and WebCrypto with
explicit popup/channel/fetch or disk-admission seams. They verify request/config
snapshots, strict callback and token parsing, atomic credential replacement,
pre-digest and held-token cancellation, manual-key races and failed response
cleanup. Lifecycle cases with controlled page events cover cached-document
suspension, show/hide supersession, late disk admission, the 16-admission bound,
cleanup failure refusing resume and relay-token invalidation. The actual browser
history tests record `restoredFromCache: 0` in both engines; they qualify fresh
document reconnection, not actual cached-document restoration.

The [existing host regression](./results/browser-oauth-host-regression-macos.json)
passes **30 tests**, including both engines' 32 MiB disk download and retained-file
cleanup. The regional host Node suite passes **10 tests**. The
[deployment report](./results/browser-oauth-deployment-macos.json) passes **11
checks** against the actual local nginx response: isolation/referrer/cache/CSP
headers, exact built callback bytes and no log entries for the successful callback
request. The nginx configuration also discards that route's error logging; an
injected callback-serving error was not exercised by this focused probe.
Its container is removed afterward. CI now runs the OAuth command per configured
browser and uploads its reports; remote CI execution is not claimed.

The [shared application regression](./results/browser-oauth-app-regression-macos.json)
passes **42 groups in each engine**, with all 71 recorded source hashes matching.
It exercises the existing chat/import/routing/branch/summary/archive workflows
and their credential-boundary scan through the changed browser host. The
[aggregate checks](./results/browser-oauth-checks-macos.json) retain successful
command logs, source/report hashes and the local deployment artifact. `npm run
check` passes with the final runtime sources. Schema 12 and archive protocol 4
are unchanged.

The [initial host regression attempt](./results/attempts/browser-oauth-host-initial-macos.json)
passed 29 tests but reached the existing WebKit 32 MiB test's 30-second timeout
while waiting for its download event. That unchanged test passed a focused rerun
and the final full suite. The first timeout's cause is not established; no product
assertion or timeout was relaxed. This remains an intermittent qualification
concern rather than a demonstrated product defect fixed by OAuth changes.

## Limits

- These tests qualify loopback HTTP fixtures in secure browser contexts. They do
  not qualify public HTTPS hosting, provider CORS/client registration/consent,
  production reverse proxies, a real account or an installed Safari release.
- Automated history navigation does not guarantee back/forward-cache admission.
  Actual `pageshow.persisted` observations must be read separately from controlled
  lifecycle-unit tests; a reload pass is not a cached-document restoration pass.
- COOP severs the popup WindowProxy. Closing that window cannot reliably signal
  cancellation; the original caller must cancel explicitly or await its deadline.
  Shared provider-login UI remains dependent on a qualified registration.
- The focused fixture checks localStorage/sessionStorage and cross-tab credential
  separation, not an exhaustive memory, IndexedDB, OPFS or export forensic scan.
  Existing shared-application regression covers its broader credential boundary.
- Only access tokens are stored. Refresh/ID tokens are discarded, expiry is
  validated but not scheduled, and provider rejection requires explicit reconnect.
  A provider may have issued a token before a cancelled exchange finishes; local
  cancellation is not server-side token revocation.
- JavaScript strings, fetch internals and browser-hidden headers cannot be
  deterministically zeroized or bounded by this application's buffers. Malicious
  same-origin code is outside the protection of this memory-only host abstraction.
- Callback query removal prevents later address/referrer use; it cannot erase an
  initial request already logged upstream. Every deployment layer must omit
  callback query strings. The local nginx test does not qualify a public proxy.
- Remote CI execution, release images, other machines and end-to-end provider
  login remain unqualified by these local results.
