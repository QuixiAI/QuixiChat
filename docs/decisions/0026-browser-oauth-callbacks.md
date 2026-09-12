# ADR 0026 — Browser OAuth with isolated callback delivery

Date: 2026-09-10

Status: Implemented; controlled Chromium/WebKit callback qualification passed.

## Requirement and architecture

Plan 05 and product sections 6.2, 6.3 and 8 require OAuth behind the browser
`HostClient`. ADR 0005 requires memory-only browser credentials and preservation
of production COOP/COEP. The native transaction in ADR 0025 does not implement
this browser path.

Use an authorization-code public client with PKCE S256. The original host session
owns the verifier, state, pending request and token exchange. A dedicated static
same-origin callback document returns only the authorization response to that
session through a transaction-specific BroadcastChannel. It does not initialize
the application, Storage Worker or provider adapters. There is no token backend,
new Quixi account requirement, persisted verifier or cross-tab credential sharing.

RFC 10017, published August 2026, describes the browser-only pattern but recommends
stronger backend architectures for applications handling sensitive personal data.
Quixi's existing local-first/direct-provider and self-hosted static deployments
make a mandatory credential-holding backend a consequential change to its trust
model. This increment preserves ADR 0005's explicit session-only public-client
boundary and keeps every production OAuth registration disabled. Before enabling
a provider, review this tradeoff, its public-client policy and token authority.
Memory-only storage does not protect a browser session from malicious same-origin
JavaScript or a compromised application origin. OAuth proves delegated API access;
it does not establish a Quixi login or authenticate an ID token.

## Registration and ownership

Composition-owned registrations fix the provider binding, authorization/token
endpoints, issuer, client ID, allowed scopes, exact redirect and deadline. They
cannot be supplied by `startOAuth`, a callback, URL parameters or browser storage.
The existing HostClient request supplies registered identities and requested
scopes only. The production registry remains empty; capability reports unavailable.
Only registered browser-direct resource bindings with Bearer injection are
eligible; this flow does not invent relay authorization or token forwarding.

The callback is the exact same-origin `/oauth/callback.html` HTTPS URL. Authorization
and token endpoints require HTTPS; an explicit loopback exception exists for
controlled local fixtures. Requests are authorization code plus S256, with fresh
256-bit random state and verifier. No client secret or offline access is accepted.
This registration policy requires an exact `iss` response parameter on both
success and correlated denial; providers without issuer responses need a separate
reviewed mix-up defense before registration.

`startOAuth` must be invoked directly from a user gesture. It opens an empty
window synchronously before awaiting the WebCrypto challenge, removes its opener
while still same-origin, then navigates it to the assembled authorization URL.
A popup-owned link explicitly uses `rel=noreferrer` and a no-referrer policy;
the main application need not supply a stronger referrer header for this to work.
A blocked window is an explicit failure. COOP can sever the retained WindowProxy;
`window.closed` therefore cannot reliably distinguish closure from isolation.
Cancellation belongs to the original request and its bounded deadline. Closing
the authorization window alone may leave the original request pending until that
deadline or explicit cancellation.

The original session must be top-level, secure and cross-origin isolated. A
partitioned embed or missing isolation remains unavailable. The same-origin
callback can communicate only in the same browser storage partition. Loss of the
original session requires reconnection; a new session cannot recover its verifier.

## Callback and token boundary

Both app and callback retain `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. The callback applies `no-referrer`,
`no-store` and a restrictive CSP, has no external assets, and replaces the visible
URL/history entry before creating a channel. This cannot erase the initial
navigation from upstream infrastructure; the shipped nginx exact route disables
callback access/error logging, and every upstream proxy must omit query strings.

Channel names are `quixi-oauth-v1:<state>`. The callback sends
`{type: 'quixi-oauth-callback', url}`. The host checks the exact registered endpoint,
issuer, state, deadline, owner, bounded field syntax and one-use status before
responding with `{type: 'quixi-oauth-result', status: 'accepted' | 'rejected'}`.
No verifier, access/refresh token or credential handle crosses the channel.
The acknowledgement reports receipt, not successful token exchange. Without an
active owner, the callback times out and tells the user to reconnect.

Callbacks are capped at 8 KiB and authorization codes at 4 KiB. Invalid, duplicate,
late and unsolicited callbacks cannot exchange a token or consume a different
pending transaction. A correlated denial consumes its own request. The accepted
code is exchanged through a dedicated memory-only fetch, with redirects refused,
credentials omitted, caching disabled and no referrer. Token endpoints must
support browser CORS; an unavailable CORS path does not fall back to a relay.

Token bodies are capped at 32 KiB and access tokens at the existing 16 KiB limit.
At most four operations are active through the shared host registry, with bounded
completion receipts; at most 32 OAuth registrations are accepted. Authorization
URLs are capped at 8 KiB. Token headers exposed by fetch are limited to 32 fields
and 8 KiB combined; browser-hidden headers cannot be inspected. Header/body waits
are limited to ten seconds within a total transaction deadline of five minutes.
Duplicate (including escaped aliases) and unknown token JSON fields are refused;
returned scopes must be a subset of the requested scopes.
Only a valid bearer access token is published under the exact disconnected
session binding. Optional refresh and ID tokens are discarded; neither automatic
refresh nor ID-token authentication nor an expiry timer is implemented. Reconnect
after access-token rejection. JavaScript strings and browser/network internals
cannot be promised deterministic zeroization or application-level heap bounds.

## Cancellation and credential mutation

OAuth uses the host's operation identities and cancellation boundary. The browser
has no asynchronous OS keychain commit: final owner/deadline/binding checks and
session-secret insertion occur synchronously. Manual credential replacement must
also remove the old secret and insert its replacement in one synchronous section;
awaiting cleanup in between would let another credential occupy the binding.

Cancellation, disposal, pagehide and manual binding mutations invalidate pending
OAuth. Token fetch abortion cannot revoke a token the provider might already have
issued, so external-effect reporting remains conservative. A cancelled request
cannot subsequently publish a session credential. A future connection UI must
cancel the pending request even when it has no credential handle yet.

Back/forward-cache restoration must not reuse a permanently closed host. A
persisted pagehide clears credentials, cancels active work and suspends admission;
the restored document may resume only after temporary-transfer cleanup completes.
In-flight transfer admission must recheck its lifecycle before returning a handle.
An ordinary unload/disposal remains permanent. This preserves reconnect and local
file operations without silently resurrecting credentials or pending OAuth.

## Official sources and qualification

Checked 2026-09-10:

- [RFC 10017](https://www.rfc-editor.org/rfc/rfc10017.html), sections 6.3, 8 and 9:
  public clients, PKCE, browser messaging, CORS and the limits of memory storage.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): redirect matching,
  code-injection and authorization-server mix-up defenses.
- [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html): issuer responses and
  exact comparison after form decoding.
- [WHATWG HTML BroadcastChannel](https://html.spec.whatwg.org/multipage/web-messaging.html#broadcasting-to-other-browsing-contexts):
  same storage-key delivery and channel lifetime.
- [MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)
  and [window.open](https://developer.mozilla.org/en-US/docs/Web/API/Window/open):
  browsing-context separation and popup/user-activation behavior.
- [Vite build options](https://vite.dev/config/build-options#build-rollupoptions):
  HTML entry configuration; the pinned build supports `rollupOptions` as an alias
  of `rolldownOptions` and emits the separate callback document.
- [nginx access logging](https://nginx.org/en/docs/http/ngx_http_log_module.html#access_log):
  disabling request logging on the exact callback location.

The [qualification record](../validation/browser-oauth.md) links 44 actual
Chromium/WebKit groups, 12 unit groups and 11 static-server checks. These cover
authorization navigation and built callback return under unchanged isolation,
PKCE exchange and credential use, invalid/late/duplicate callbacks, cancellation
and credential races, bounded failures and nginx headers/log omission.
Synthetic loopback qualification cannot establish installed Safari, public HTTPS
hosting, real-provider CORS/registration/consent or protection against same-origin
script compromise. Actual back/forward-cache restoration was not observed;
its reset and cleanup races are covered by controlled lifecycle units only.
