# 0005 — Host capabilities, credentials, and provider transport

**Status:** Proposed implementation design for [plan 05](../plans/05_implement_host_capabilities_and_relay.md), with initial browser/native adapters and a separately packaged relay with local fixture evidence. Plan 05 remains incomplete; capability support remains subject to the gates below.

**Research date:** 2026-09-08. Dependency versions mentioned here are research snapshots, not installed dependencies or release support claims.

## Context and ownership

[Product §6](../product.md#6-deployment-architecture) and [§8](../product.md#8-host-architecture) put privileged operations behind `HostClient`. [§30](../product.md#30-provider-adapters) keeps authentication formats, endpoint semantics, stream parsing, and provider errors in provider adapters. [§35](../product.md#35-privacy-classes) requires the user to see the actual transport's privacy class. Credentials and relay availability must not make local history depend on a server or Cloud account.

At the start of this review, the web and desktop composition roots mounted the shared application without a production host adapter. The desktop's storage-proof commands are an opt-in test harness, not provider infrastructure. Docker's [nginx.conf](../../deploy/docker/nginx.conf) served static files with no relay. The implementation boundaries are:

| Location | Responsibility |
| --- | --- |
| `apps/web/src/host/` | Browser capabilities, session secrets, direct/relay HTTP, browser files and OAuth callback coordination. |
| `apps/desktop/src/host/` | TypeScript adapter translating `HostClient` calls into scoped native commands. |
| `apps/desktop/src-tauri/src/host/` | Native secret store, registered destinations, request/transfer lifetimes, dialogs and callback validation. |
| `apps/relay/` | Independently deployable, authenticated provider forwarding service; no history database or archive service. |
| `packages/core/src/contracts/host.ts` | Platform-neutral contracts; no Tauri, DOM, Node, or secret-store imports. |

Initial browser and native implementations now live in `apps/web/src/host/` and `apps/desktop/src/host/`; the separately packaged relay lives in `apps/relay/`. Capability and release claims remain limited to their recorded evidence. StorageWorker continues to own canonical SQLite and storage transactions. Host transfers carry bounded bytes; they do not introduce a second canonical database.

### Initial relay evidence

On 2026-09-08, [the relay service](../../apps/relay/README.md) passed 16 controlled service tests on macOS Node 22.23.1 and local Linux arm64 Docker Node 22.23.2. Tests exercise separate hashed relay authorization, exact registry/origin checks, pinned connections with temporary TLS certificate/hostname verification, proxy exclusion, byte/deadline/admission/rate limits, bounded unresolved DNS, slow-consumer backpressure, disconnect cleanup and diagnostic redaction. The actual browser HostClient additionally passed staged raw-body/CORS/error/stream/cancel integration against this service in Chromium 153.0.8010.12 and Playwright WebKit 26.6. The production image starts read-only as UID 1000 and excludes fixture policy code; no provider endpoint or public deployment was used.

The frozen wire is POST `/v1/provider-http` with raw bytes, a server-registered destination ID and exact method/path headers; v1 has no path templates. Since 2026-09-09 a route registration may permit named query parameters: the interface passes `query` on `ProviderHttpRequest`, the browser host encodes only registered names onto the direct URL or into one `X-Quixi-Query` header, the relay re-encodes parsed pairs against its own route registry and refuses anything else (`UPSTREAM_QUERY_DENIED`), and the native host applies the same allowlist from Rust. The first use is Anthropic model listing (`after_id`, `before_id`, `limit`); every other route still refuses a query. Public egress is HTTPS on port 443, DNS-resolved and pinned with original-host TLS checks. Limits are per instance; public TLS ingress, deployed proxy buffering evidence, provisioning/revocation, fleet-wide abuse controls and operational log retention remain release gates. [Service instructions and exact Node/IANA sources](../../apps/relay/README.md) document the implementation and compatibility limits. This evidence does not complete plan 05 or the browser large-export gate.

### Native file evidence

The desktop adapter now implements opaque selected-file handles, bounded positional reads, release and disk-backed `file_save` staging. On 2026-09-08, [the actual macOS Tauri file proof](../../tests/hosts/results/tauri-native-files-macos-26.5.2.json) transferred a 256 MiB synthetic file using 64 KiB IPC chunks, verified the output digest, preserved an existing destination when cancelling a copy, and released all normal staging/readers/grants. The initial native-process RSS peak was approximately 108 MiB; WebKit/content-process memory was not measured. The transfer took about 80 seconds and is not evidence that product-scale archive throughput targets are met. Provider requests retain the separate 8 MiB staging cap.

A [separate native-panel run](../../tests/hosts/results/tauri-native-dialogs-macos-26.5.2.json) actually presented open/save panels and cancelled them through AppKit sheet callbacks, without programmatic path substitution. File correctness tests use explicitly synthetic native selections; neither suite claims a tested human selection/overwrite-confirmation flow. Normal error/cancel cleanup is verified. Forced termination during a destination-side copy can leave a private named temporary sibling, and crash ownership/recovery, remote filesystems, signed-app permissions and Windows/Linux durability remain gates. [Native adapter details](../../apps/desktop/src/host/README.md#native-files-and-large-exports) link the exact dialog/tempfile APIs and document disk/admission limits and commit outcomes.

### Initial browser evidence

On 2026-09-08, the [browser host fixture suite](../../apps/web/tests/README.md) passed 18 tests across Chromium and Playwright WebKit. It exercises real fetch streams, upstream disconnect after cancellation, bound session credentials, hash-verified staging, resource limits, actual file selection/download and fixed relay wire mapping. [Adapter notes](../../apps/web/src/host/README.md) specify the protocol and limits. OAuth remains explicitly unsupported. Plan09 subsequently added disk-backed browser file-save staging and actual 32 MiB downloads in both engines, including retained-file cleanup and injected picker cancellation; provider-request staging retains its separate 8 MiB cap. Browser-native save-dialog/notification evidence, very large archive qualification and production relay/provider integration remain open gates. See [ADR0010](./0010-portable-archives.md). These results do not establish support for installed Safari or a real provider.

## Contract requirements before adapters

Implement against the finalized [host contract](../../packages/core/src/contracts/host.ts) and [transfer contract](../../packages/core/src/contracts/transfer.ts). During this review, plan 02 added `CapabilityState`, `ProviderBinding`, explicit transfer/file release methods, host-owned OAuth configuration and `HostCancellationResult.externalEffect`. Confirm the final transport privacy classification and these lifecycle requirements before coding:

- Report availability, permission state, and an actionable unavailable reason separately. A platform name or `notifications: true` cannot express denied permission, absent keychain service, unregistered OAuth, or an unverified integration.
- Describe each registered transport with destination identity, relay identity where applicable, and product privacy class. Browser/native identifies the implementation mechanism; it does not identify who receives the request.
- Bind HTTP requests and secret handles to a host-registered provider/destination configuration. Resolve URLs, permitted methods/paths, credential injection and redirect policy against that configuration. The host must reject a caller combining an existing secret with an unrelated URL.
- Give outbound transfers explicit allocation, finalization and release operations, and selected file handles an explicit release operation. Specify ownership by host session/window, expiration, cancellation, final acknowledgement, and cleanup on host shutdown. Unknown or cross-owner handles fail closed.
- Include bounded deadline policy and distinguish local cancellation from external effects. After dispatch, terminating local I/O cannot establish that a provider performed no work or charged nothing.
- Start OAuth by registered provider/configuration identity. The host owns a one-use pending transaction, state, PKCE verifier, expected callback and timeout. Caller-supplied arbitrary authorization/callback URLs are insufficient authorization.

Public contracts must remain useful for custom and self-hosted endpoints. An explicitly configured local inference server may legitimately use loopback or a private network. Such a destination is a separate binding with its own disclosure; it never inherits a hosted provider's credential or the public relay's privileges.

## Credentials and user disclosure

### Desktop

Use OS credential stores through `keyring-core` and explicit platform store crates. Current `keyring` 4.2 documentation recommends this arrangement for applications choosing particular stores; copying older `keyring` 3 feature configuration would select the wrong integration model. Candidate dependencies are `keyring-core` 1.0, `apple-native-keyring-store` 1.0 and `windows-native-keyring-store` 1.1, resolved and locked during implementation. [Keyring application guidance](https://docs.rs/keyring/latest/keyring/)

Use macOS Keychain for the current desktop packaging. The Apple crate distinguishes its `keychain` backend from the provisioned, protected-data backend; a future sandbox/App Store distribution needs its own entitlement and migration review. On Windows, explicitly select local-machine credential persistence: the store's documented default is Enterprise persistence. [Apple store](https://docs.rs/apple-native-keyring-store/latest/apple_native_keyring_store/), [Windows store](https://docs.rs/windows-native-keyring-store/latest/windows_native_keyring_store/)

Use an application service name plus an opaque credential UUID. Serialize mutation/read operations for the same entry: the abstraction is thread-safe, but underlying stores do not guarantee ordered concurrent operations on one credential. Never use the mock or sample store as a production fallback. Linux requires a separately selected and tested Secret Service integration; absence or a locked service becomes an explicit capability/error state. [Keyring core guarantees and limitations](https://docs.rs/keyring-core/latest/keyring_core/)

Return only an opaque `SecretHandle` to shared code. Native commands resolve credentials immediately before the bound request and expose no general secret-read command to the UI. Input necessarily passes through the credential-entry UI; clear the field and temporary buffers promptly, without claiming complete erasure of browser or OS memory. Keychain errors must not trigger silent plaintext persistence.

### Browser

The initial policy is **memory-only credentials for the current application session**. Keep API keys, relay tokens, OAuth refresh/access tokens and PKCE verifiers out of localStorage, sessionStorage, IndexedDB, OPFS, service-worker caches, URLs, history records, archives and Cloud payloads. OAuth token-exchange bodies containing verifiers or credentials must therefore use bounded memory, never general disk-backed upload staging. Reloading or closing the owning app session requires reconnection. Do not broadcast secrets between tabs; a separate tab may require its own connection.

Before saving a connection, disclose: “This browser session keeps your credential in memory. Reloading requires reconnecting.” Desktop instead identifies OS keychain persistence. Deleting a connection removes its local secret, clears pending auth state, and cancels its active requests. Local deletion is not provider revocation: expose provider-specific revocation guidance or a supported revocation action when that adapter implements it.

For a relay connection, additionally disclose the named operator and that the relay receives the request content and the provider credential needed to forward it. TLS protects each connection; the relay can read the forwarded content. Stateless forwarding is not end-to-end encryption. Privacy labels must describe the effective route, including a change from direct provider to relay; never silently retry through a different operator.

## Bounded HTTP and cancellation

### Browser adapter

Use `fetch`, a response-body reader and `AbortController`; resolve response metadata when headers arrive and expose bytes through host transfer IDs. Abort must cover both the initial fetch and subsequent body consumption. Direct provider transport is supported only for provider endpoints whose CORS and authentication requirements actually permit it; `no-cors` gives an unreadable opaque response and is not a workaround. Use `credentials: "omit"` for provider requests unless a registered authentication protocol explicitly requires otherwise. [Fetch streaming, CORS and cancellation](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)

Browser streaming **uploads** need a separate compatibility result. A streaming response does not prove streaming request-body support. Initially permit bounded request bodies with an endpoint-specific maximum; advertise large streaming upload support only after measuring the actual browser/provider path. File import can remain streaming independently of HTTP upload support.

### Desktop adapter

Use narrow async Rust commands around `reqwest`, with credentials injected natively. The official HTTP plugin is a useful scoped fetch implementation, but exposing its generic fetch surface would not itself establish Quixi's destination/secret binding or transfer lifecycle. Prefer the custom host command boundary for those requirements. [Tauri HTTP plugin](https://v2.tauri.app/plugin/http-client/)

Read the response incrementally using `Response::chunk` or `bytes_stream`, never by collecting a whole streaming body with `text`, `json` or `bytes`. Configure redirect, connection, read and total deadline behavior explicitly; preserve normal TLS verification. Review resolved TLS/stream features when adding the dependency. [Reqwest response API](https://docs.rs/reqwest/latest/reqwest/struct.Response.html), [Reqwest client configuration](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html)

Map the pull/acknowledgement contract to bounded binary IPC using `tauri::ipc::Response` and raw request payloads, with validated metadata framing. Tauri supports binary responses and recommends channels for streaming; a channel may carry bounded progress/control messages, but does not replace Quixi's acknowledgement window. Do not send bulk content through global events or unbounded JSON arrays. Commands remain async and scoped to the intended application WebViews. [Tauri command, binary and channel APIs](https://v2.tauri.app/develop/calling-rust/)

### Shared resource policy

The core contract's 1 MiB maximum chunk and four in-flight chunks are ceilings. Start adapters at 64 KiB chunks, four outstanding chunks per transfer, four active provider requests and sixteen active transfers per host session. Apply a separate aggregate byte budget covering queued payloads, request staging and intermediate buffers; reject excess work with the existing overload error instead of extending queues. These are proposed initial limits, to be tested rather than advertised as measured memory usage.

Use explicit connect/header/idle/total timers. Initial policy candidates are 15 seconds to connect, 60 seconds for response headers, 120 seconds without body progress and 15 minutes total, with bounded provider-specific overrides validated in plan 06. Browser APIs may combine connection and header timing. Cap header metadata and error previews, validate sequence/offset/acknowledgements, and release credits on every exit path. Provider adapters parse SSE/JSON incrementally; host code transports bytes and status without interpreting model events.

Preserve HTTP status and a bounded response body for provider normalization; distinguish permission, transport, deadline, cancellation and overload errors through typed boundary errors. Logs contain identifiers, status, duration and byte counts, never raw error bodies or credential-bearing headers. Do not automatically retry a dispatched generation POST. Cancellation must stop producers, abort readers/writers, close native tasks and release transfers, while reporting that external effects may already have occurred.

## OAuth callbacks

Implementation update (2026-09-10): [ADR 0025](./0025-native-oauth-callbacks.md)
implements the macOS native transaction and installed callback boundary. The
[qualification record](../validation/native-oauth.md) covers synthetic PKCE/TLS,
Keychain use, cold/warm OS delivery, failure, cancellation and session loss. The
production registry remains empty. Browser OAuth is now implemented under
[ADR 0026](./0026-browser-oauth-callbacks.md), with its own
[qualification record](../validation/browser-oauth.md). Windows/Linux delivery
and real provider registrations remain open.

Desktop authorization opens the system browser through a narrowly scoped opener. Use authorization code plus PKCE and an external user agent. Prefer an ephemeral loopback listener bound only to loopback where the provider's registered native client supports it; otherwise use an explicitly registered application URI scheme. Exact callback support is provider-specific. [Tauri opener](https://v2.tauri.app/plugin/opener/), [OAuth for native apps, RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)

Deep links must handle cold and warm startup. Tauri documents static macOS scheme registration and single-instance integration for Windows/Linux delivery to an existing process. Treat command-line and plugin-delivered URLs as untrusted inputs: validate the pending provider, exact callback components, one-use state, expiration, bounded length, and expected code/error fields before completing a transaction. Late, duplicate and unsolicited callbacks fail without navigation or token exchange. Installed-bundle registration must be tested separately from a debug executable. [Tauri deep-link integration](https://v2.tauri.app/plugin/deep-linking/)

Browser OAuth must preserve the deployed COOP/COEP headers. `Cross-Origin-Opener-Policy: same-origin` can sever the cross-origin popup's opener relationship. Proposed approach: open the popup during the user's gesture, keep the pending transaction in the original host's memory, and return to a dedicated same-origin callback page which communicates over a transaction-specific `BroadcastChannel`. This is a design inference requiring tests: BroadcastChannel requires the same storage partition as well as origin. Do not depend on `window.opener`, weaken isolation, or persist a verifier merely to make redirect recovery work. [COOP behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy), [BroadcastChannel partitioning](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API)

The callback page contains no third-party assets, clears callback parameters from the visible URL after capture, and applies a no-referrer policy. Reverse-proxy access logs must omit callback query strings. Send no access or refresh token over the channel. Validate the one-use callback in the host, then exchange the code only through the registered token destination. If the original session has closed, reject the callback and require reconnecting. Popup blocking and unavailable provider/browser token exchange become explicit unsupported/cancelled outcomes, not hidden credential persistence.

## Files and notifications

Desktop uses the native dialog plugin to select files or an export destination; native code retains the path/handle behind an opaque `HostFile` ID. Stream reads and writes through bounded host transfers, validate metadata again when opening, and remove partial temporary exports on cancellation. Use a temporary sibling file and finalize atomically where the platform supports it; never accept an arbitrary UI-supplied native path. [Tauri dialog APIs](https://v2.tauri.app/plugin/dialog/)

Since 2026-09-09, files dropped onto the interface reach the shared UI as platform file objects and are handed to `HostClient.adoptFiles`, which registers them under the same bounds as chosen files (name, media type, size, bounded positional reads) so the interface streams every file through host transfers and never reads platform objects itself. The browser adapter wraps `File.slice`; the desktop bridge serves adopted files from JavaScript in 64 KiB slices while native dialog selections keep native readers, and the Tauri window sets `dragDropEnabled: false` so HTML5 drops reach the WebView ([tauri-utils 2.9.3 WindowConfig](https://docs.rs/tauri-utils/2.9.3/tauri_utils/config/struct.WindowConfig.html), read 2026-09-09). The [browser fixture suite](../../apps/web/tests/README.md) covers adoption, streaming, release and metadata refusal; native drop delivery is not yet exercised.

Browser imports use selected `File` objects and `Blob.stream()`. Save-picker support is feature-detected and requires a user gesture; it is not available uniformly across browsers. Acquire the destination before long asynchronous work loses activation. For browsers without a streaming save destination, first establish a bounded disk-backed export/download path and cleanup behavior in actual host tests. Until then, report large export unavailable and enforce a documented small-download limit; do not concatenate arbitrary archives into RAM. [Blob streams](https://developer.mozilla.org/en-US/docs/Web/API/Blob/stream), [Save picker compatibility and activation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)

Since 2026-09-10 the host reports a `clipboard` capability and offers `writeClipboardText` for bounded text (at most 262,144 characters) from a user action. The browser adapter uses the page clipboard only in a secure context and reports it unavailable otherwise; the desktop bridge uses the WebView's page clipboard in the same way, augmenting the native capability report from JavaScript, so nothing native runs for it and it has not been exercised in a native window. The interface shows copy controls only when the capability is available and reports a refused write as a readable outcome. Chromium reads the written text back in the fixture; WebKit gates clipboard reading behind platform UI, so its evidence is the successful write.

Notifications are capability- and permission-gated. Request permission through an explicit user action; use generic completion text by default and opt-in content previews. Validate notification actions against a typed application action registry. Browser persistent notifications require a service worker; page notifications have a different lifetime and mobile support. Desktop uses the notification plugin, with installed-Windows-app behavior tested separately from development execution. [Browser notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API), [Tauri notifications](https://v2.tauri.app/plugin/notification/)

Plan 05 establishes these boundaries. Feature-specific notification actions, extension pairing and signed updater wiring belong to their consuming milestones; no placeholder capability should report them available before implementation and validation.

## Relay deployment and trust boundary

Implement a small Node HTTP service under `apps/relay`, with its own image/configuration and controlled-endpoint tests. Keep the existing static web image usable without it. A reverse proxy may route `/relay/` to that service, but ordinary assets, SQLite/WASM, models and OPFS history remain on their current paths. Quixi-hosted and operator-hosted instances use the same forwarding protocol and identify their operator to the client.

The relay accepts registered provider/operation IDs, not an arbitrary destination URL. A server-owned registry fixes HTTPS destinations, exact allowed methods/paths, no v1 query fields, authentication injection and size/deadline limits for the first supported providers. Resolve and validate destinations against public-network policy at connection time; deny redirects by default, private/link-local targets and user-selected proxy settings. Custom/private inference endpoints use a separately configured direct or self-hosted transport, never the public provider relay.

Require relay authorization independently of the forwarded provider credential. Initial self-hosted configuration may use an operator-issued high-entropy relay token, held in the browser's session secret store and compared against server-side configured hashes. Public Quixi deployment additionally needs provisioned, revocable service authorization and abuse limits before publication; a token embedded in a Vite bundle is not authentication. This service authorization does not enable Cloud history or require uploading an archive. Fix allowed web origins, authenticate before reading a large body or dispatching upstream work, and apply per-principal concurrency, request-size and rate limits.

The relay consumes the two credentials for distinct purposes: validate relay authorization locally, then inject only the bound provider credential upstream. Forward an allowlist of request/response headers; strip cookies, hop-by-hop fields, relay authentication and unsupported redirects. Stream bytes unchanged without collecting complete SSE responses. Respect downstream backpressure and cancel upstream on a prematurely closed downstream response. Node's `write()` return value and `drain` event provide the required flow-control signal; request/header timeouts must also be configured. [Node HTTP APIs](https://nodejs.org/api/http.html)

Disable reverse-proxy response buffering for the relay location; disable request buffering only for implemented streaming upload routes. Configure proxy timeouts consistently with the application policy and verify first-chunk latency through the deployed local proxy. Preserve existing cross-origin isolation headers. [Nginx proxy buffering and timeout controls](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)

Keep prompt bodies, provider credentials, OAuth codes and response text out of access/application logs, caches, queues, analytics and crash diagnostics. Use `Cache-Control: no-store` for forwarding and auth responses. Retain only documented operational/authentication metadata with a bounded retention policy. This is history-stateless operation, not a claim of zero transient memory or zero access by the relay operator.

| Effective route | Product privacy class and disclosure |
| --- | --- |
| Local inference endpoint on this device | **Local**; validate the configured route actually stays on this device. |
| Browser or native HTTP directly to a supported provider | **Direct provider**; name the provider. |
| Forwarding through Quixi's service | **Quixi relay**; name Quixi and the upstream provider. |
| User-operated remote endpoint or relay | **Self-hosted remote**; display the configured operator/endpoint and any upstream provider. |
| Other configured remote service | **Custom remote**; display the endpoint and declared operator. |

These classifications follow [product §35](../product.md#35-privacy-classes); a hostname alone cannot establish ownership. Persist connection metadata and the user's selection without persisting browser secrets.

## Compatibility and implementation review gates

The following are acceptance work, not results of this research:

1. **Contract gate:** freeze destination/credential binding, actionable capabilities, outbound transfer lifecycle, OAuth ownership and external-effect cancellation semantics with plan 02. Shared provider code must compile against either adapter without platform imports.
2. **Controlled transport evidence:** run the same synthetic endpoint suite through browser direct, native Tauri and relay paths. Cover incremental bytes, slow consumers, bounded queues, body/header deadlines, non-2xx bodies, disconnects before/after headers, cancellation during upload/download, redirect rejection, concurrent request isolation and cleanup. Inspect memory growth and upstream cancellation rather than only checking a resolved promise.
3. **Credential and relay evidence:** test temporary OS-keychain CRUD/locked-store failures and session disappearance after reload. Assert no synthetic secret in logs, history or exports. Relay fixtures cover unauthorized access, denied destinations, credential/destination mismatch, oversized work and proxy buffering. No real user credential or paid provider call is required.
4. **OAuth/file evidence:** test synthetic successful, mismatched, expired, duplicate and cancelled callbacks; real browser popup behavior with shipped isolation headers; installed native cold/warm deep links; user-cancelled dialogs; large fixture transfers, partial-write cleanup and export capability fallbacks.
5. **Release gate:** record exact OS/WebView/browser/package versions for actual integrations. Existing [macOS Tauri storage evidence](../../tests/hosts/results/tauri-macos-26.5.2.json) establishes a storage baseline only. [Safari automation evidence](../../tests/hosts/results/safari-macos-26.5.2-automation.json) remains unverified for runtime storage. The tested [Linux WebKitGTK 2.50.6 backend](../../tests/hosts/linux/README.md) cannot support the canonical OPFS access-handle path; adding native secrets or HTTP does not clear that database gate. Windows host integration is unverified here. Follow [product §110](../product.md#110-releaseplatform-risks).

Implement the frozen contracts and synthetic host/relay fixtures first, then connect the first provider registry from plan 06. Provider-specific CORS, OAuth client registration, streaming upload and authentication behavior require their own evidence before advertising a supported connection. Public relay publication, signing and credential provisioning are separate release work; this ADR neither performs them nor marks plan 05 complete.
