# Native OAuth and macOS callback qualification

Date: 2026-09-10

Implementation policy: [ADR 0025](../decisions/0025-native-oauth-callbacks.md).
Plan: [05 — Host capabilities](../plans/05_implement_host_capabilities_and_relay.md).

## Runtime under test

The desktop `HostClient.startOAuth` method invokes the native session boundary.
Native configuration owns the provider binding, HTTPS endpoints, issuer, client,
allowed scopes and exact callback. The native host generates 256-bit random
state and a PKCE verifier, opens the assembled authorization URL through its
Rust-only opener, admits a single callback, exchanges the code through bounded
native HTTPS, and publishes an opaque keychain credential for an empty binding.

The production registry has no OAuth provider configurations. Its capability
remains unavailable and an attempted login returns `UNSUPPORTED`. No provider
client ID, real account, paid request or live registration is qualified here.

The macOS host routes Tauri `RunEvent::Opened` URLs directly to native admission.
It closes abandoned sessions on page-load start as well as window destruction.
The static production Info.plist registers `ai.quixi.chat`. Other native platforms
do not acquire OAuth support through that macOS event hook.

Cancellation invalidates pending work. Once the serialized keychain actor enters
the irreversible commit phase, cancellation reports `unknown_outcome` and the
caller reconciles through `openSecret`. Concurrent credential mutations refuse
while that commit is unresolved. Manual connection and disconnection also
invalidate pending OAuth by binding, including a recheck inside the secret actor.
Cancellation visits matching OAuth, file and HTTP work instead of returning
after the first registry match.

## Reproduction

The installed proof requires macOS 14 or newer and a working desktop session:

```sh
npm run test:host:oauth:native
cargo test --locked -p quixi-desktop --bin quixi-desktop -- --test-threads=1
npm run test:core
npm run check
npm run tauri --workspace @quixi/desktop -- build --debug --bundles app
python3 tests/hosts/regional-app-proof/run.py --output docs/validation/results/native-oauth-regional-regression-macos.json
python3 tests/hosts/regional-app-proof/run.py --skip-build --output docs/validation/results/native-oauth-regional-repeat-macos.json
```

The proof uses a separate application identifier, unique registered URL scheme,
WKWebView UUID data store and keychain service. Its temporary CA and native DNS
override reach only the synthetic TLS token endpoint. A separate loopback HTTP
fixture observes use of the returned keychain credential through the production
provider HTTP boundary. That observation establishes native credential use; it
does not establish TLS for that separate HTTP resource fixture.

Authorization-browser opening is replaced by a feature-only native observer. Its
private temporary control files can contain synthetic authorization URL/state
for the runner; they are fixture coordination, not production transaction storage
or retained evidence. The verifier remains in the native transaction and reaches
only the synthetic token endpoint. Actual callbacks are sent through macOS
LaunchServices to the installed proof application, not injected into the callback
validator. Retained reports exclude raw callback queries, token bodies and
authorization control files.

## Evidence

The [installed native report](./results/native-oauth-macos.json) passes **21
phases (20 behavior phases and cleanup), 219 assertions**, with 24 actual OS
callback deliveries, 13 TLS token requests and 8 authenticated native HTTP probes.
The environment is macOS 26.6.2 arm64, system WebKit 21624.5.1.11.3. All 49
recorded source hashes match the reviewed sources. Cold launch uses LaunchServices;
warm callbacks reach an already running installed application. Each phase records
the native event-loop exit separately from the URL launcher's exit status.

The proof covers exact state/issuer/path admission, duplicate fields and delivery,
correlated denial, expiry, cancellation, disposal, renderer reload, overload,
invalid/oversized/malformed/redirected token responses and discarded auxiliary
tokens. Invalid callbacks followed by a valid callback prove the original pending
transaction remains usable. Cancellation during a held TLS exchange prevents
credential publication. Cancellation after the real keychain actor's commit
cutoff returns an unknown outcome; a new session reopens and uses the credential
before deleting it. A shared request ID exercises cancellation of both OAuth and
file staging. Unknown registrations/scopes and occupied bindings are refused.

The [aggregate checks](./results/native-oauth-checks-macos.json) retain command
outputs, source and artifact hashes: **21 Rust tests** (18 OAuth and 3 existing),
**61 core tests**, `npm run check` and the local debug application bundle pass.
`target/debug/bundle/macos/Quixi.app` contains the production `ai.quixi.chat`
scheme in its generated Info.plist; it was built locally, not installed or published.
CI now runs and uploads the isolated OAuth proof in its macOS desktop job; a remote
CI result is not claimed.

The [regional application regression](./results/native-oauth-regional-regression-macos.json)
and its [independent repeat](./results/native-oauth-regional-repeat-macos.json)
each pass **63 checks across five phases**, including TLS refusal, canonical
restart and cleanup. Both reports have 60 matching source hashes. These exercise
existing shared-app workflows through the changed native host.

Two earlier regional runs reached their native watchdog at different write-phase
checkpoints ([first attempt](./results/attempts/20260910T211729Z-5d77dcfe-c928-41e6-97d1-80fa382998e4.json),
[second attempt](./results/attempts/20260910T215138Z-232d299d-0551-4e52-a640-72a4afd37294.json)).
The fixture's polling deadline did not bound an individual unanswered storage
read. Its reads now have deadlines, and a caught failure is checkpointed before
cleanup. No product assertion was removed or relaxed. Both subsequent runs pass,
but the cause of those unanswered reads is not established; recurrence requires
investigation of worker request/reply and lifecycle progress, not a longer timeout.

Exploratory OAuth cleanup attempts could not remove the active WebKit data store
through the platform API. The passing runner verifies its unique app directory
was absent before installation, waits for its own processes to exit, unregisters
and removes its bundle, then removes only that proof-owned WebKit directory and
temporary control/TLS files. All cleanup checks pass; platform data-store deletion
API success is not claimed.

## Limits and remaining gates

- External system-browser authorization UX and real provider client registrations
  remain unqualified. The proof observer establishes the assembled authorization
  request and PKCE exchange, not that external UX.
- Browser OAuth still requires a callback flow tested under production COOP/COEP
  and storage-partition behavior. Windows/Linux installed callback delivery and
  single-instance handling, plus provider-specific loopback redirects, remain open.
- Only access tokens are retained. Optional refresh and ID tokens are discarded;
  refresh, ID-token authentication and native expiry enforcement are not provided.
  A future connection UI must cancel its pending OAuth request even when no
  credential handle exists yet. Expired access tokens require explicit reconnect.
- A cold callback cannot resume a lost transaction. Its original session/state
  are intentionally absent; the installed test must observe refusal before any
  token exchange.
- Native URL checks operate on the parsed URL Tauri supplies. Tests of raw
  malformed strings do not establish that the OS preserves their original bytes.
- Renderer-storage snapshots cover localStorage and sessionStorage. This focused
  proof does not initialize a canonical archive or claim an OAuth-specific
  OPFS/export scan. The runtime returns only an opaque handle and does not call
  storage APIs; broader archive credential-boundary evidence remains in the
  [shared application validation](./shared-app.md).
- Body and metadata limits bound application retention; they do not constitute
  a measured bound on OS URL parsing, TLS, WebView or HTTP-library heap usage.
- An unsigned/local test bundle does not qualify signing, updates, distribution,
  other machines or release installation/upgrade persistence.
