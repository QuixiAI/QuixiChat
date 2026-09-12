# ADR 0025 — Native OAuth transactions and callback admission

Date: 2026-09-10

Status: Implemented; macOS synthetic installed-host qualification passed.

## Requirement and scope

Plan 05 implements the privileged OAuth boundary required by product sections
6.1 and 8. ADR 0005 already requires host-owned state, PKCE, exact callback
admission, cancellation and installed-application tests. This decision specifies
the macOS native transaction path. Browser OAuth, Windows/Linux delivery,
loopback redirect listeners, provider registrations and notification workflows
remain required follow-up work; this increment does not qualify those paths.

The production OAuth registry starts empty. Existing API-key connections remain
the only configured provider connections. A working synthetic registration proves
the runtime without inventing a provider client ID, borrowing another app's
registration or claiming a supported provider login. Shared UI must continue to
read the host's capability state.

## Registration and transport

The native configuration fixes the provider/account/destination/transport binding,
client ID, authorization endpoint, token endpoint, issuer, exact private-scheme
redirect URI, allowed scopes and transaction deadline. JavaScript supplies only
the existing `OAuthRequest`: request ID, provider ID, configuration ID and a
subset of allowed scopes. No UI-supplied endpoint, callback, verifier or secret
is accepted. Registration is validated before the host starts.

Authorization and token endpoints require HTTPS with no user information or
fragment. Redirects are not followed during token exchange. The native opener
opens only the authorization URL assembled from the admitted registration; the
renderer receives no general opener permission. OAuth codes are exchanged in
bounded native memory, never via the disk-backed file or generic HTTP staging
paths. A proof-only constructor can substitute an isolated loopback endpoint and
authorization observer; production does not read its environment or enable it
from renderer input.

The first registration form supports authorization code with PKCE S256 and a
private URI scheme. A registered callback must carry an exact matching `iss`
parameter in addition to state. This is a deliberately explicit issuer admission
policy: providers without that response parameter need a separately reviewed
registration policy before enablement. Automatic refresh and offline access are
not part of this registration form. Only the access token is stored; optional
refresh and ID tokens are discarded and their native buffers cleared. The runtime
does not authenticate an identity from an ID token. A supplied positive expiry
is validated, but this slice does not persist or enforce an expiry timer. The
provider's rejection of an expired access token reaches the existing connection
health path; reconnecting remains explicit. Registrations requiring refresh or
offline access need the remaining credential-lifecycle implementation first.

## Transaction ownership and bounds

The native host owns cryptographically random state and verifier, a monotonic
deadline, an owner session and the completion channel. They exist only in memory.
At most four transactions may be active across the host; overflow is refused,
not queued. Transaction lifetimes are capped at five minutes. Callback URLs are
limited to 8 KiB and authorization codes to 4 KiB. Token responses are limited
to 32 KiB; the existing 16 KiB credential limit also applies. Every network wait
is cancellable and bounded by the remaining transaction lifetime.

The bounded receipt table retains at most 64 completed/live request identities;
closing an owner removes its receipts, and late completion cannot recreate them.
Admission across HTTP and OAuth also prevents simultaneous request-ID collision.

Admission checks the exact registered redirect, field syntax and bounds,
duplicate/unknown query parameters, issuer, state, transaction lifetime and owner.
Fragments, user information and ambiguous callback forms are refused. Code and
provider error are mutually exclusive. A malformed or unrelated callback cannot
consume another transaction. An admitted code or correlated provider denial
consumes state before any token exchange; duplicate, late and unsolicited URLs
cannot navigate the interface or exchange a token. Errors contain fixed text
and operational identifiers, never raw callback queries or provider responses.

The OS event supplies an already parsed Tauri URL. Exact comparison applies to
that serialized URL and its endpoint components; it cannot recover or reject
original input bytes that the platform parser normalized before delivery.
Native processing also caps the URL count per event. Platform parsing and its
allocations precede this boundary and are not covered by the host's buffer limit.

There is no persisted transaction recovery. A cold-start callback has no valid
pending owner and is refused. The user reconnects in a new session. This is
different from dropping cold-start OS events: delivery and refusal must both be
observed in an installed application test.

## Credential publication and cancellation

`OAuthRequest` contains no authority to replace a credential. The binding must
therefore be disconnected at admission, and publication uses the secret actor's
existing compare-and-set behavior with no replacement handle. OAuth cannot
silently overwrite a manually connected API key.

Cancellation, session disposal and manual credential mutations invalidate pending
OAuth work for the appropriate transaction or binding. The native secret actor
rechecks that authority immediately before publication. OS keychain writes cannot
be interrupted once dispatched. A transaction atomically enters `COMMITTING`
inside the serialized secret actor immediately before the OS call, after checking
the session and cancellation state. Before that cutoff cancellation prevents
publication. After it, cancellation reports `unknown_outcome` with
`may_have_occurred`; a cancelled or closed caller receives `UNKNOWN_OUTCOME` and
can reconcile the credential with `openSecret` on its registered binding.
Competing manual credential mutations refuse while this irreversible commit is
active, then can be retried after reopening the credential. Do not attempt an
automatic rollback or deletion that might race another credential operation.
No successful result is delivered to an owner that has closed. The result contains
only the registered binding and opaque native `SecretHandle`.

## macOS delivery

Use Tauri's native `RunEvent::Opened` hook in the host builder to route OS URLs
directly into native admission. Do not install a renderer deep-link event handler
or forward raw callback URLs to it. Static `CFBundleURLTypes` configuration supplies
the application scheme. An isolated proof bundle uses a distinct scheme, bundle
identifier, WKWebView data store and keychain service, and must remove its own
LaunchServices registration after testing.

Windows/Linux single-instance argument forwarding and its untrusted argument
admission need their own implementation and installed-host evidence. The macOS
event hook does not prove those platforms.

## Sources and review

Official sources checked 2026-09-10:

- [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html): external user agents,
  public native clients, PKCE and native redirect methods.
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html): redirect matching and
  authorization-server mix-up defenses. Mandatory exact `iss` above is this
  implementation's registration policy.
- [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html): issuer response
  parameters on success and error, form decoding followed by exact string
  comparison, and an explicit policy permitting issuer-support-only clients.
- [Tauri deep linking](https://v2.tauri.app/plugin/deep-linking/): static macOS
  registration, installed-bundle testing and separate Windows/Linux delivery.
- [Tauri opener](https://v2.tauri.app/plugin/opener/): system URL opening.
  `cargo info tauri-plugin-opener` resolved 2.5.5; its published Rust source
  exports `open_url(url, None::<&str>)`. Pin that version and the lockfile.
- [Tauri RunEvent](https://docs.rs/tauri/latest/tauri/enum.RunEvent.html) and the
  downloaded pinned 2.11.5 `src/app.rs`/`src/plugin.rs`: the platform-gated
  `Opened { urls }` event and native plugin `on_event` hook. The default Linux
  docs.rs rendering omits the macOS-only variant; the pinned source establishes it.
- [Tauri configuration](https://v2.tauri.app/reference/config/#infoplist): macOS
  Info.plist integration.

An independent review identified the credential-resurrection race: pending OAuth
has no existing secret handle, so cancellation by handle alone is insufficient.
Binding invalidation and publication checks above are required before acceptance.

## Qualification

The [qualification record](../validation/native-oauth.md) links 21 installed native
phases and 219 assertions, 21 Rust tests, 61 core tests, two 63-check native app
regressions and the local production-entry bundle. It records tested admission,
PKCE exchange, credential use, cancellation/commit races, lifecycle and bounds,
along with retained failed attempts and their limits. The static production
scheme is bundled; OAuth capability remains unavailable with the empty registry.
Synthetic opener observation does not qualify actual external browser/provider
authorization UX. No live OAuth connection is enabled by this ADR.
