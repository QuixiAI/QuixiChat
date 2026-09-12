# Browser host adapter

`createWebHost(config)` creates one host session implementing the shared `HostClient`. The composition root owns configuration and calls `dispose()` when replacing or closing the session. Provider adapters receive the injected interface and opaque credential/transfer handles. No provider is registered by default.

Destinations bind provider, account, destination and transport IDs to an HTTPS origin, exact allowed paths/methods, allowed request headers and a credential header/prefix. An explicitly configured loopback HTTP origin is permitted for local inference and controlled tests. Requests cannot override authentication or select arbitrary URLs/redirects. The five product privacy classes are reported separately from browser-direct/relay mechanics. A successful fetch fixture does not establish CORS support for a real provider.

Credentials remain in a private session map and are never persisted. Returned handles are copied and include the binding. Replacement/deletion clears owned bytes and cancels requests using the old credential. JavaScript/HTTP implementations can make temporary copies; this does not promise complete heap erasure. A new host session cannot use the previous session's handles.

## Transfers and errors

Imports and HTTP responses expose 64 KiB chunks with at most four unacknowledged chunks. Acknowledgement uses the exact sequence and end offset. The final chunk can be empty; final acknowledgement releases the source. At most sixteen transfers and four active host operations are admitted. Oversized source chunks above 1 MiB fail instead of being retained without a bound.

Provider-request staging has an **8 MiB per-transfer limit** and **16 MiB retained-payload budget**, including explicit verification/use copies. These are application buffer accounting limits, not an assertion about total browser heap or network/WebCrypto internal allocations. SHA-256 and final length must match before a staged request can be consumed. Release and cancellation free owned buffers and readers. Request staging remains owned by its original transfer lifecycle after HTTP dispatch; the caller releases it when finished.

Browser `connectMs` bounds fetch through response headers, because fetch exposes no separate TCP-connect event. `idleMs` bounds a pending source read, and `totalMs` bounds the full HTTP operation, including consumer stalls. All timers are positive and at most the core maximum. There are no automatic request retries. Cancellation after dispatch reports `may_have_occurred`; it cannot establish that the provider did no work. Non-2xx status/body are preserved for provider normalization. Transport, cancellation and source errors use shared string codes, including WebKit's native abort exceptions.

File-save staging uses OPFS writable streams with incremental SHA-256 and bounded disk readback. It has no whole-file memory buffer or 8 MiB limit. Writes use 64 KiB chunks/four credits; unavailable private writable storage returns an actionable capability reason. This is separate temporary storage, not canonical SQLite. `fileStagingNamespace` is an optional composition-owned profile namespace.

File input imports use actual browser-selected `File` objects behind releasable IDs. Files dropped onto the interface are adopted through `adoptFiles` under the same 256-handle bound after name, media type and size validation, and stream through the same bounded positional reads. Export writes through `showSaveFilePicker` when available; otherwise an OPFS-backed File is handed to the browser. This means download handoff, not verified disk durability. Up to four handed-off files survive transfer release and reload until the user confirms completion and explicitly clears them. `fileSaveCapability()`, `listTemporaryDownloads()` and `clearTemporaryDownload(requestId,id)` support this UI. There is no timer-based deletion and no browser completion callback. Web Locks protect live staging, and later staging performs bounded orphan cleanup. Notification permission requires an explicit caller-triggered action; notification action routing remains unsupported.

## Relay protocol, version 1

Configuration uses `transport.kind: "relay"`, an explicit privacy class/operator identity, a relay origin `baseUrl`, and `relayDestinationId` registered by that server. `setRelayAuthorization(destinationId, bytes)` retains a separate session-only relay token. Clearing or replacing it cancels the destination's active requests.

The wire request is **POST `/v1/provider-http`**, without a query string of its own. Its body is the raw provider request body, not a JSON envelope. Empty provider requests have an empty body. Headers are:

| Header | Meaning |
| --- | --- |
| `Authorization: Bearer …` | Relay authorization; never forwarded upstream. |
| `X-Quixi-Destination` | Server-registered destination ID; never a URL. |
| `X-Quixi-Method` | Registered upstream method. |
| `X-Quixi-Path` | Exact registered upstream path. |
| `X-Quixi-Query` | URL-encoded upstream query pairs, present only when the request carries `query`; the browser accepts only names the route registers (`query`, none by default), at most eight, values at most 256 characters without control characters, and encodes them itself for direct transport. |
| `X-Quixi-Provider-Authorization` | Raw provider secret, if supplied. Server registry selects the real auth header and prefix; never log this field. |
| `X-Quixi-Configuration` | Required only for an admitted regional relay, identifying its reviewed registration. |
| Other configured headers | Only the route's allowed headers, such as `Content-Type`; server must independently validate them. |

The relay returns upstream status and response bytes incrementally. The browser exposes only `content-type`, `retry-after`, `x-request-id` and `request-id` response headers. Relay failures can return their own status and a bounded structured error body. The server must authenticate, restrict routes/destinations, prevent credential/header overrides, enforce bounds, redact logs and propagate disconnect cancellation; the browser adapter does not establish those server guarantees.

## Regional relays

`VITE_QUIXI_RELAY_CONFIG` can add a bounded `regional` array (at most one entry
per US/Europe region). Each entry requires `region`, `destinationId` and the
64-character `configurationId` computed from the relay’s authoritative
registration. Optional `origin`, `operator` and `privacy` override the ordinary
relay configuration, so one app can use distinct US and European operators.
Every production origin must be HTTPS and privacy must remain a remote relay
class. No configuration field contains a provider or relay credential.

For example, append a `regional` entry to the ordinary configuration:

```json
{
  "region": "eu",
  "destinationId": "regional-openai-eu",
  "configurationId": "REPLACE_WITH_THE_SERVER_COMPUTED_64_HEX_DIGEST",
  "origin": "https://eu-relay.example.com",
  "operator": "Reviewed European operator",
  "privacy": "self_hosted_remote"
}
```

The placeholder is deliberately rejected until replaced. Generate the identity
from the independently reviewed server configuration using the
[relay provisioning command](../../../relay/README.md#regional-declaration-and-provisioning).
A declaration covers the operator/region, exact upstream destination, routes and
credential scheme. It is a configuration agreement, not measured geography.
The operator receives relayed content and the provider credential. OpenAI account
eligibility and regional image eligibility require separate session confirmations
in Providers; a successful metadata or model-list response cannot grant them.

The host accepts only the reviewed regional model/endpoint facts and exact
`quixi-openai-{us|eu}-relay-v1` bindings. It checks authenticated
`POST /v1/regional-configuration` with no provider credential or content during
capability admission and freshly before dispatch. Responses are limited to 4 KiB
and ten seconds, reject redirects, and must exactly match the expected version,
identity, operator, region, destination and upstream. The content request carries
`X-Quixi-Configuration`; the server checks it again before reading/forwarding the
body or connecting upstream. Ordinary global routes cannot use that header.

Checks share a pending capability probe per destination; dispatch always probes
again. After that asynchronous check the host invokes the workflow’s final local
policy guard immediately before sending content. This callback is never serialized
to the relay or native bridge. Disposal and authorization replacement cancel checks and active requests.
Authorization epochs prevent an older asynchronous update from restoring a
cleared token and prevent late capabilities from advertising obsolete permission.
Capability responses are deep copies of private registry data. Tokens stay in
memory and a new session requires authorization and eligibility again.

Unknown/mismatched declarations leave a regional connection unavailable without
blocking local archive access. A declaration changed after an attempt is created
can leave a failed audit record, but the final guard refuses content dispatch.
See [regional relay validation](../../../../docs/validation/regional-web-relays.md)
and run `npm run test:host:regional` plus `npm run test:app:relay:browser`.

## Remaining implementation gates

- Browser OAuth now implements a host-owned, memory-only PKCE transaction and the built `/oauth/callback.html` under production isolation. `WebHostConfig.oauthConfigurations` accepts trusted public-client registrations for direct Bearer resource bindings; the production table remains empty and reports `UNSUPPORTED`. Real provider registration/CORS/consent and public callback hosting remain open. See [browser OAuth qualification](../../../../docs/validation/browser-oauth.md) and [ADR 0026](../../../../docs/decisions/0026-browser-oauth-callbacks.md).
- Very large archive throughput, memory/disk amplification and quota-capacity preflight remain release gates. Actual 32 MiB disk-backed browser downloads pass both engines; this does not qualify arbitrarily large histories.
- Native browser save-picker cancellation/commit and system notification delivery require actual platform evidence. Current automated evidence covers file-input selection, real disk-backed downloads, and injected picker mechanics using real destination streams; it does not automate OS save dialogs.
- Real provider CORS/authentication and public relay deployment/authentication remain unverified. No real provider, user credential or public deployment is used by the fixture suite.

See [ADR 0005](../../../../docs/decisions/0005-host-capabilities.md) and [browser host tests](../../tests/README.md).
