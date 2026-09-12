# 0011 — Provider setup and credential reopening

Status: Accepted for the first bounded integration; live account and platform qualification remain open.

## Scope and ownership

[Product sections 8, 30–32 and 35](../product.md#30-provider-adapters), [plan 06](../plans/06_integrate_live_providers.md) and [plan 08](../plans/08_build_chat_and_library_ui.md) require host-owned credentials, typed provider capabilities and visible account/transport state. The shared feature lives under `packages/app/src/features/providers/`. Its controller produces `ConfiguredProvider`-compatible `{id,label,adapter,models}` entries through an injected callback; the application owns the controller lifetime. Navigating away from settings leaves configured chat adapters available. Disposal stops outstanding connection probes and removes observers.

The initial composition has one fixed `primary` account slot per provider. This is a local connection slot, not a discovered provider organization/user identity. Multiple accounts, arbitrary origins, dynamic native registration, OAuth, automatic routing and cross-privacy fallback remain separate work. Replacing a key does not establish that the remote provider account is unchanged; generation provenance retains the configured slot and native provider response identity.

## Reviewed catalog and transport

Since 2026-09-09 a connection check lists the provider's models, following Anthropic cursors through registered query parameters up to eight pages, and Providers reports how many models the provider lists, which are reviewed and selectable, and which are unreviewed by name; an incomplete listing is named as such. Unreviewed models stay unselectable until their capabilities and pricing are reviewed into the catalog.

Two dated catalog entries are maintained as updateable source data in `packages/providers/src/catalog.ts`. They are selected to fit the already implemented Chat Completions and Messages profiles; they are not a claim to be the latest or best models.

| Provider | Pinned model | Documented context | Documented maximum output | Request profile |
| --- | --- | --- | --- | --- |
| OpenAI | `gpt-4.1-mini-2025-04-14` | 1,047,576 | 32,768 | Chat Completions, developer prompt, streaming usage, `store:false`, `max_completion_tokens` |
| Anthropic | `claude-haiku-4-5-20251001` | 200,000 | 64,000 | Messages, top-level system, API version `2023-06-01`, streaming, `max_tokens` |

Reviewed 2026-09-08 against the fetched [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Chat Completions reference](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create), [Claude model page](https://platform.claude.com/docs/en/models/haiku-4-5/overview), [Messages reference](https://platform.claude.com/docs/en/api/messages/create) and [Claude API overview](https://platform.claude.com/docs/en/api/overview). Model access and current account entitlements are not inferred from these public documents. Connection checks make a model-list request; no generation or paid smoke runs automatically.

Re-reviewed 2026-09-09 against the same model pages, the [Messages reference](https://platform.claude.com/docs/en/api/messages/create) and the [openai-node Chat Completions parameter source](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts): context and output figures are unchanged, and both reviewed models now declare `temperature`, `topP` and `stopSequences` in addition to the output limit. OpenAI documents temperature 0–2, nucleus `top_p` and up to 4 `stop` sequences, recommending that only one of temperature or top-p is changed. Anthropic documents temperature 0–1 (default 1.0), `top_p` and `stop_sequences` without a count limit, and deprecates temperature and top-p for models released after Claude Opus 4.6; the pinned Haiku 4.5 snapshot predates that boundary. The adapter enforces those protocol ranges plus its own bound of at most 4 non-empty stop sequences of 1,024 characters; a blank composer setting is omitted from the request rather than sent as a default. A future catalog entry for a later Claude model must not declare these sampling parameters without a new review.

On 2026-09-09 the catalog gained per-million-token prices in USD from the providers' published rates: GPT-4.1 mini at 0.40 input, 0.10 cached input and 1.60 output ([OpenAI model page](https://developers.openai.com/api/docs/models/gpt-4.1-mini)); Claude Haiku 4.5 at 1 input, 0.10 cache read, 1.25 five-minute cache write and 5 output ([Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)). Quixi sends no `cache_control`, so cache writes stay at zero and the one-hour write rate does not apply. Every completed attempt records an estimate from these rates and the provider's reported usage; the interface labels it as an estimate from reviewed pricing, never as a bill, and keeps unknown values unknown. The rates are updateable catalog data with a source and review date, not fetched live.

The catalog separates provider model facts from the adapter's implemented request subset. Both documented models accept images; since 2026-09-09 the adapter subset sends PNG, JPEG, GIF or WebP images of at most 2.5 MiB each in user messages from verified attachment bytes, while file attachments remain unmapped. The UI states that scope as an adapter limitation, not a lack of model support. Reasoning continuation, file/image mappings, structured-output controls, tool invocation/rendering integration and context-budget counting remain open. Unknown discovered models do not gain reviewed capabilities or become selectable. Prices remain `null`: no estimate is fabricated, and the differentiated cache-pricing policy has not been reviewed for this setup. Effective catalog records retain a namespaced indication of adapter scope and the broader provider facts in their raw metadata.

Native composition registers HTTPS origins `https://api.openai.com` and `https://api.anthropic.com` in Rust, with only `GET /v1/models`, the appropriate generation POST path and, for Anthropic, `POST /v1/messages/count_tokens`. Authorization header injection is native-owned. Caller URLs cannot extend these routes.

Browser composition accepts an explicit trusted relay configuration with origin, operator, privacy class and separate server destination IDs. Without it, the connections are visibly unavailable. It does not assume provider CORS, introduce an arbitrary URL input, or silently select a relay. The operator identity and the relay's receipt of content/provider credentials are shown before connection. Relay authorization is separately entered and retained for this browser session. Official [Anthropic browser SDK guidance](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript) makes browser credential exposure explicit; the setup preserves the session-only policy from [ADR0005](./0005-host-capabilities.md).

## Opaque reopening and unknown outcomes

`HostClient.openSecret(requestId,binding)` returns the current opaque `SecretHandle` or `null`, without an HTTP probe or plaintext return. Both hosts require an exact registered provider/account/destination/transport binding. Browser implementation uses its existing bounded session map, refuses a second independent allocation for a binding, and loses that map on reload. No credential bytes or opaque handles are placed into history, sync, portable archives, localStorage or IndexedDB.

Native credentials use one keychain item addressed by a namespaced digest of the registered binding. That single item contains the authority (origin and credential injection policy), random opaque handle ID and secret. Replacing the single item rotates the handle and invalidates the old handle without a separate metadata-file/index commit. A save whose reply is lost can be inspected through binding-only reopen, including after process restart. A stale deletion cannot remove the replacement. A changed registered authority cannot reuse the saved credential.

Existing UUID-addressed keychain entries remain accessible only through an explicitly supplied legacy handle. They are not enumerated or guessed during reopen. Replacing an explicit legacy handle writes the new association and removes the old entry; cleanup failure attempts to remove the new association and reports an error. A failure during that legacy cleanup is not represented as a successful atomic migration. The existing native secret actor serializes reads/replacement/deletion; current platform support is the tested macOS keychain implementation, with other native targets explicitly unavailable.

The controller never automatically repeats an uncertain credential mutation. Before a write/delete it removes the connection from newly selectable adapters. An error directs the user to reopen the saved association, then make an explicit new change if needed. Submitted byte buffers are zeroed and password inputs cleared; JavaScript strings and browser internals cannot promise physical-memory erasure. Revoking a credential can cancel local transport; it does not establish that already dispatched provider computation or billing was prevented.

## Account health in the application

Since 2026-09-09 the settings controller keeps one adapter per connection and
uses it for both connection checks and chat, so account health is a single
record of what the provider last answered. The composer shows the selected
connection's health with the provider's reason and its evidence (a connection
check or the last response), refuses to send while the credential is rejected
or a rate-limit retry time has not passed, and treats the device's own offline
signal as offline; Providers shows the same health and re-checks it. Only
model-list probes are tracked for cancellation on settings disposal; chat owns
its generation requests. Nothing infers health without provider or device
evidence: a transport failure stays unknown.

## Evidence and remaining qualification

The [provider setup validation](../../packages/providers/docs/account-setup-validation.md) records controlled React/HostClient browser tests, actual macOS native process restart and keychain tests, plus controller unknown-outcome tests. These establish the bounded connection feature and host lifecycle, not a live account, provider-specific end-to-end service behavior, Windows/Linux keychain support or installed Safari qualification. Final shared application composition is tested separately by its owner.
