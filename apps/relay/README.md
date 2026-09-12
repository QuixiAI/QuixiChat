# Provider relay

This independently deployable Node 22 service implements the [browser HostClient relay protocol](../web/src/host/README.md#relay-protocol-version-1). It has no runtime package dependencies, history database, archive storage, prompt cache or provider-specific stream parser. Browser static hosting remains independent. The relay operator can read forwarded content and the provider credential; clients must disclose the operator and effective [product privacy class](../../docs/product.md#35-privacy-classes).

## Configuration and protocol

Copy [config.example.json](config.example.json) to an operator-owned configuration file. Replace its example origins/routes and zero placeholder hash. Issue each principal a cryptographically random token containing at least 32 random bytes encoded as base64url; store only the SHA-256 hexadecimal digest of the **encoded token's UTF-8 bytes** in `tokenSha256`. Deliver the token through a separate private provisioning channel. The browser holds it in its session through `setRelayAuthorization`. Do not embed a relay token in a frontend build. The service accepts 43–128 base64url token characters; a length check cannot establish entropy, so issuance must use a secure random generator. Configuration changes and revocation currently require process restart. Empty registries/principal lists disable forwarding.

The only forwarding route is `POST /v1/provider-http`, without a query of its own. The raw body is the provider request body. Required headers are relay `Authorization: Bearer <token>`, `X-Quixi-Destination`, `X-Quixi-Method` and `X-Quixi-Path`. Optional `X-Quixi-Query` carries URL-encoded upstream query pairs; the relay parses them, accepts at most eight pairs whose names the route registers (`query` in the destination registry, none by default) with values of at most 256 characters, re-encodes them onto the upstream path, and refuses anything else with `UPSTREAM_QUERY_DENIED`. Optional `X-Quixi-Provider-Authorization` contains the raw provider secret. The server selects the credential header and prefix from its own destination registration, supporting bearer and `x-api-key` schemes. A principal can access only its registered destination IDs. The browser cannot supply an upstream URL, path template expansion or an unregistered query parameter.

Every route lists exact paths, methods and safe lower-case request headers. Authentication overrides, cookies, hop-by-hop fields, duplicate headers and unknown protocol headers are rejected or omitted; relay authorization never reaches the provider. Provider responses preserve status and raw streaming bytes, exposing only `content-type`, `retry-after`, `x-request-id` and `request-id`. Redirects and non-identity content encoding are rejected. Infrastructure errors contain a fixed code and random request ID. Once response bytes have started, a failure terminates the stream; consumers must treat truncation as failure. Cancellation cannot establish whether a provider has already performed work or incurred cost.

Allowed origins are exact HTTPS origins, with HTTP loopback origins available for local UI development. Missing/unregistered origins fail; there is no wildcard, credentialed CORS or cookie authentication. Preflight permits only the wire headers and safe headers in the server registry. This CORS policy complements independent relay authentication.

## Regional declaration and provisioning

[config.regional.example.json](config.regional.example.json) is the fixed OpenAI US example. Replace the operator label, allowed browser origin and principal token hash. To declare Europe, change both `region` fields to `eu` and the upstream to exactly `https://eu.api.openai.com`. Global destinations remain supported without either regional field.

The optional top-level `regionalProcessing` contains an operator label of 1–256 characters without surrounding whitespace, ASCII control characters or DEL, and `region: "us" | "eu"`. A destination with `processingRegion` must match that region and its exact registered HTTPS OpenAI origin. Its only routes are `GET /v1/models` (no forwarded headers) and `POST /v1/chat/completions` (`content-type` only); neither permits query parameters. Credentials must use the required `Authorization: Bearer ` scheme. Other regional origins, routes, credential schemes and forwarded headers fail startup validation.

Provision the expected declaration separately from the relay authorization token. This helper validates the operator's configuration and prints only public declaration fields:

```sh
node --input-type=module - /absolute/path/config.json regional-openai-us <<'JS'
import { readFile } from 'node:fs/promises';
import { regionalConfiguration } from './apps/relay/src/config.mjs';
const [file, destinationId] = process.argv.slice(2);
const config = JSON.parse(await readFile(file, 'utf8'));
console.log(JSON.stringify(regionalConfiguration(config, destinationId), null, 2));
JS
```

The resulting object is `{version:1, configurationId, operator, region, destinationId, upstreamOrigin}`. `configurationId` is a SHA-256 lowercase hexadecimal digest of stable JSON containing `{version:1, operator, region, destination:{id, origin, routes, credential}}`. Object keys are sorted; routes are sorted by path; method/header/query sets are sorted; the credential header is normalized to lowercase. Principal tokens, token hashes, origin permissions and rate limits do not enter this identity. Changing the operator, declared region or destination definition requires provisioning and reviewing its new identity. Never manually choose or accept an identity based only on an operator's hostname or label.

An authenticated `POST /v1/regional-configuration` accepts an allowed `Origin`, relay `Authorization` and `X-Quixi-Destination`. It requires an empty body and refuses provider credentials and provider-routing headers. Its response is bounded to 4 KiB, has `Cache-Control: no-store`, and returns the exact declaration above without DNS resolution or upstream requests. It shares principal authorization, CORS, rate, concurrency and deadline controls with forwarding. Its preflight permits only `authorization,x-quixi-destination`.

Regional forwarding additionally requires `X-Quixi-Configuration` equal to the server's current computed identity. A missing or changed value returns `403 REGIONAL_CONFIGURATION_MISMATCH` before any body read, DNS lookup or upstream connection. Global destinations reject this header. The metadata request lets the client check its independently provisioned declaration before submitting provider credentials or conversation content; the forwarding header fences a restart/configuration change between that check and dispatch. Neither the metadata response nor the digest proves where the operator's infrastructure physically executes. The operator can read relayed content and provider credentials, and must substantiate its processing-location declaration separately. These fields do not establish data residency, account eligibility or data-at-rest guarantees.

## Network and resource boundaries

The production executable requires upstream HTTPS DNS names on port 443. It resolves once, rejects any result set containing an unavailable address, selects one address and pins the request's lookup to it. It verifies the actual connected address before flushing headers or uploading bytes. TLS retains certificate and original-hostname verification. Special IPv4 ranges, mapped IPv6, non-global IPv6 and special-purpose IPv6 allocations are excluded conservatively. No redirect, retry, global agent, environment proxy or caller-selected proxy is used. There is no alternate-IP retry. Operator network routing remains outside application control; enforce egress policy at the deployment boundary too.

Controlled tests inject a loopback policy through the library constructor. Regional fixtures also inject `connectPort` and a temporary `tlsCA` there so ephemeral loopback TLS retains the fixed upstream hostname and certificate verification; neither option is accepted in JSON or used by the production policy. The production entry point always selects the public policy; JSON has no test/private-egress switch, and the production Docker image excludes tests. Temporary TLS tests generate their own disposable certificate/key and never read an existing private key.

Defaults are 8 active upstream requests, 2 per principal, 64 client connections, 8 MiB upload, 64 MiB response, 120-second total and 30-second idle deadlines. Token buckets apply global and per-principal rates; registry sizes and metadata are bounded. Outstanding OS DNS resolutions retain their own bounded admission slot even after the HTTP deadline, because an OS resolver operation cannot reliably be cancelled. Upload and response loops honor `write()`/`drain`; they do not collect complete bodies. Stream and socket internal buffers still consume memory. Limits are per process and reset on restart; replicas need edge-wide admission/rate controls.

The executable logs only request ID, configured principal/destination ID, status/error code, byte counts and duration. It never logs request headers, tokens, URLs, body bytes or upstream error strings. Diagnostic writes are dropped when stdout is backed up beyond 64 KiB. Logs are operational metadata and still need an operator retention policy. Reverse proxies, crash/core dumps and platform monitoring require corresponding redaction and retention settings. The service does not persist credentials or promise complete erasure of runtime/network copies.

## Run and verify locally

From the repository root:

```sh
QUIXI_RELAY_CONFIG=/absolute/path/config.json node apps/relay/src/main.mjs
node --test apps/relay/tests/*.test.mjs
node apps/relay/tests/browser.mjs
node apps/relay/tests/container.mjs
```

The service listens on `HOST` (default `0.0.0.0`) and `PORT` (default `8081`). `GET /healthz` is a minimal unauthenticated liveness check. The tests use synthetic loopback endpoints only. TLS tests require OpenSSL; browser tests use the repository's Vite and Playwright installations. The container harness builds the isolated test target, runs it read-only, then starts the production image on a randomly assigned loopback port and verifies health/auth/origin behavior with forwarding disabled. It removes the temporary container and configuration afterward.

For an operator-controlled local container:

```sh
docker build -t quixi-relay apps/relay
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=256m --pids-limit=64 -p 127.0.0.1:8081:8081 \
  --mount type=bind,src=/absolute/path/config.json,dst=/config.json,readonly \
  -e QUIXI_RELAY_CONFIG=/config.json quixi-relay
```

This image serves HTTP behind the operator's TLS ingress. Public use requires HTTPS termination, private ingress-to-service networking, disabled request/response buffering for this streaming route, aligned deadlines, safe access logs, provisioned/revocable principals and deployment-wide abuse controls. No public deployment, real provider compatibility or production reverse-proxy buffering behavior is established by the local tests. The v1 relay origin must expose `/v1/provider-http` exactly and regional deployments also expose `/v1/regional-configuration`; mounting it under a prefix requires an explicitly reviewed ingress rewrite. The initial browser staging cap and large archive export gate remain separate from the relay's incremental network implementation.

## Evidence and official API references

The regional-declaration iteration passes 26 service tests, including nine new regional cases. Controlled US/EU TLS fixtures verify the fixed hostname, pinned connection, exact routes, bearer credential forwarding, metadata without provider content, stale-identity refusal before upload/DNS, principal limits, and wrong-certificate rejection. They do not contact OpenAI or establish operator geography.

On 2026-09-09, 17 service tests passed on macOS arm64 Node 22.23.1 (the seventeenth covers registered query re-encoding and refusals). Actual browser adapter integration passed Chromium 153.0.8010.12 and Playwright WebKit 26.6, covering cross-origin preflight, staged raw body, error metadata, incremental delivery and cancellation to the actual relay. The same service suite and a read-only non-root production startup passed in local Linux arm64 Docker using Node 22.23.2. These are controlled local results, not installed Safari or public-provider support claims.

Implementation choices follow the [Node 22 HTTP APIs](https://nodejs.org/download/release/v22.23.2/docs/api/http.html), [HTTPS/TLS agent options](https://nodejs.org/download/release/v22.23.2/docs/api/https.html), [DNS lookup API](https://nodejs.org/download/release/v22.23.2/docs/api/dns.html), [stream backpressure and iterator APIs](https://nodejs.org/download/release/v22.23.2/docs/api/stream.html), and [network BlockList API](https://nodejs.org/docs/latest-v22.x/api/net.html#class-netblocklist). Address exclusions were checked against the [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/) and [IPv6 special-purpose registries](https://www.iana.org/assignments/iana-ipv6-special-registry/). Review these classifications and the pinned container digest during dependency updates. See [ADR 0005](../../docs/decisions/0005-host-capabilities.md) for the remaining host and release gates.
