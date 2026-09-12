# @quixi/providers

OpenAI-compatible Chat Completions and Anthropic Messages adapters share the injected `HostClient`. `startGeneration` persists either stream through the public `StorageClient`. Historical export parsing belongs to `@quixi/importers`; route selection, compatibility choices and producer liveness belong to application orchestration.

This is a working, bounded protocol and persistence slice. It has controlled HTTP acceptance evidence in Chromium, Playwright WebKit and the actual macOS Tauri WebView. It has not made a paid request or verified a live provider account. Application composition and Anthropic prompt counting are implemented; remaining content profiles and release qualification stay open.

## Composition contract

Factories `createOpenAICompatibleAdapter(options)` and `createAnthropicAdapter(options)` accept a host, exact provider/account/destination/transport binding, opaque credential handle, reviewed model catalog, injected UUID factory and clock. `describeAccount`, `authenticate`, `listModels`, `describeModel`, `capabilities`, `prepare`, `stream`, `countTokens` and `estimateCost` expose typed outcomes. Discovery does not infer capabilities or prices from a model name. `listModels(cursor)` requests Anthropic's documented maximum page (`limit=1000`) and follows `after_id` cursors from `last_id` while `has_more` is true ([Anthropic List Models](https://platform.claude.com/docs/en/api/models-list), read 2026-09-09); the OpenAI-compatible list has no documented pagination, so one page is the listing and a listing that still claims more is reported `complete:false` without a cursor. Hosts encode the cursor as registered query parameters.

The composition root owns destination registration. Native registration must happen in Rust. Required routes and credential injection are:

| Protocol | Registered routes | Caller headers | Host credential injection |
| --- | --- | --- | --- |
| OpenAI-compatible | `GET /v1/models`, `POST /v1/chat/completions` | `content-type` | `Authorization: Bearer …` |
| Anthropic | `GET /v1/models`, `POST /v1/messages`, `POST /v1/messages/count_tokens` | `content-type`, `anthropic-version` | `x-api-key: …` |

The browser can use an explicitly configured direct or relay transport. The relay's registered server destination selects the provider origin; requests cannot supply another URL. Provider adapters neither retrieve plaintext secrets nor choose a transport/privacy class. See [ADR0005](../../docs/decisions/0005-host-capabilities.md) for host and relay trust boundaries.

`authenticate(signal?)` and `listModels(cursor?, signal?)` accept optional abort
signals for metadata probes. Cancellation guards dispatch, cancels the host
request, releases late response bodies and leaves observed health unchanged.
A late probe also preserves any newer generation/count/probe health observation,
using an internal revision rather than wall-clock ordering. The shared app's
[background health controller](../../docs/validation/background-health.md) uses
this path without sending conversation content or replacing explicit discovery.

`stream(input)` returns one `AsyncIterable<ProviderEvent>` plus `cancel()`. Events preserve received raw bytes before normalized output and before the corresponding host read acknowledgement. The consumer controls backpressure. Terminal delivery follows transport cleanup. Cancellation before dispatch prevents a request; cancellation after dispatch does not promise prevention of provider processing or billing. A new attempt needs fresh request, generation and output IDs. There is no network retry or SSE reconnection.

`startGeneration({adapter,input,storage,attempt:{generation,output},nextId,now,reconnectStorage?,onCreated?,onCheckpoint?})` returns `{result,cancel}` immediately. The caller supplies a fresh empty streaming Generation, unsealed output, existing context and sealed parent. The consumer commits creation before network dispatch. `result` resolves with `{generationId,terminal,persisted,error}`. `onCheckpoint` receives only committed sequence/part counts; observers cannot undo a successful write. A reconnect callback replaces storage only. Canonical operation IDs and payloads survive retries; unknown replies are reconciled through `operationStatus` before restaging bytes.

Producer coordination uses the awaited `onCreated({generationId,outputMessageId,createOperationId})` hook after durable creation and before any provider stream/HTTP dispatch. Registration rejection attempts a terminal `failed` checkpoint; cancellation before or during the hook prevents dispatch and attempts a `cancelled` checkpoint. The coordinator maintains liveness while the result is pending and releases after the result. It separately accounts for crashes between creation and registration. Storage-owner replacement does not imply producer loss. If storage fails, the consumer releases transport and returns `persisted:false`; existing checkpoints remain and the generation can still be `streaming`. Only confirmed producer termination authorizes recovery to `partial`. The provider consumer never invokes crash recovery itself.

## Representation and preservation

The request mapping handles inline text, tool calls, provider-call-ID-resolved tool results and, since 2026-09-09, user-message images: the caller supplies verified attachment bytes keyed by attachment ID, and PNG, JPEG, GIF or WebP images of at most 2,621,440 bytes each (at most 20 per request, with their base64 expansion counted against the 4 MiB request bound) become Anthropic base64 `image` blocks or OpenAI `image_url` data URLs; unsupported models, non-user roles, missing bytes, other media types, oversized images and excess counts are explicit compatibility issues. User PDF files map verified original bytes through the reviewed file profile. The application rehydrates verified blob-backed text before mapping. GPT-Audio-1.5 accepts verified WAV/MP3 user Audio parts as `input_audio` blocks and explicitly requests `modalities:["text"]`; other models/protocols refuse audio by name. Images, files and audio share a 2.5 MiB raw attachment-occurrence budget. Reasoning continuation and other unmapped parts produce `CompatibilityError` with bounded issues. See [audio-input qualification](../../docs/validation/provider-audio-input.md) for the model, MIME, persistence and pricing limits. Tool outputs are represented, never executed. OpenAI-compatible endpoints must support this declared Chat Completions profile: `max_completion_tokens`, `store:false`, and `stream_options.include_usage`. Other compatibility profiles require explicit configuration/implementation rather than silently removing fields.

Output normalization handles text, tool JSON, citations, refusals, Anthropic reasoning metadata and provider usage. Unknown events, signatures and provider-specific fields remain raw artifacts. Unsupported file output is preserved as an artifact, not advertised as a downloadable attachment. SSE finish markers are mandatory: malformed/truncated output becomes `partial` once content has arrived, otherwise `failed`. Explicit output-limit/other nonstandard stop reasons become `stopped`; normal end/tool-call boundaries become `complete`. Stop reasons remain available in the response manifest.

Each raw transport checkpoint is a verified `raw_source` blob, standalone `RawObject`, and ordered `ProviderArtifact` with kind `quixi.provider.raw-stream-chunk`. No fake `ImportSource` is created. Reconstruct the stream by reading those parts in order and concatenating their referenced bytes. A logical `generation-stream/record/N` locator can span several transport segments; it is not a claim that one blob contains a whole SSE record.

`Generation.rawResponseId` references a final verified JSON manifest containing response/request identity, safe response headers, terminal state, raw usage, reviewed pricing/catalog provenance, and bounded reassembly metadata. Each segment has a direct canonical reference, so blob retention does not depend on following opaque JSON links. A provider response ID also creates a scoped generation `SourceIdentity`. Raw segments and normalized text are durable independently before the terminal manifest; interrupted storage writes do not erase preceding checkpoints.

Complete Anthropic thinking and redacted blocks also produce a versioned
`quixi.provider.anthropic-thinking-block` raw receipt after block closure. Text,
signatures and opaque data are preserved exactly, with generation/response/index
and source-range metadata. Capture is limited to 256 KiB per block and 1 MiB per
generation; malformed or incomplete blocks never acquire complete receipts.
[Capture qualification](../../docs/validation/reasoning-block-capture.md) covers
lost replies, browser restart, isolated portable restore and native transport.

Continuation is provenance-bound ([ADR 0032](../../docs/decisions/0032-reasoning-continuation.md)).
`parseThinkingReceipt` checks a receipt against the version-1 contract,
`bindReasoningEvidence` binds an output message's ReasoningMetadata markers to
receipts that name its generation, response, model, block kinds, ascending
indexes and exact opening stream records, and `reconstructThinkingReceipts`
rebuilds receipts from retained raw segments (8 MiB bound) through the same
decoder and normalizer when a generation predates receipts. A caller passes the
verified entries as `ProviderInput.reasoning`, keyed by marker part ID. The
mapper carries a verified thinking or redacted block first and unchanged only
under the `anthropic-manual-haiku-4.5` profile of the producing model; every
other case is a named refusal (`reasoning_evidence_missing`, `_mismatch`,
`_invalid`, `reasoning_model_mismatch`, `reasoning_order`, `reasoning_limit`,
`reasoning_role`, `reasoning_unsupported`, `reasoning_evidence_part`). Display
summaries are never evidence. `thinkingBudgetTokens` maps to
`thinking: {type: "enabled", budget_tokens}` under that profile only, with the
documented constraints (at least 1,024, below `max_tokens`, no temperature,
top-p within 0.95–1; read 2026-09-11) refused by name, and the count endpoint
receives the same `thinking` configuration and blocks.

## Bounds and accounting

Requests are at most 4 MiB, with 2,048 messages, 4,096 input parts, bounded tools/JSON depth and catalog-required parameters. SSE records are at most 256 KiB; one attempt receives at most 64 MiB and 100,000 records. Active tool JSON is at most 256 KiB per call and 1 MiB overall. Accumulated provider usage metadata and each host/raw checkpoint are at most 64 KiB. Canonical text segments are at most 16,384 characters, and an attempt has a 100,000 checkpoint-part ceiling. The first implementation commits each emitted normalized part, so small-delta throughput still needs product-scale measurement and batching review. It does not buffer a whole response or unbounded raw-segment manifest in memory.

Anthropic cumulative output usage replaces earlier values. Its normalized input total includes uncached, cache-read and cache-write counts while retaining the original fields. OpenAI prompt/completion totals and cached/reasoning details remain distinguishable. Unknown fields stay `null`. Cost uses injected dated decimal pricing, integer arithmetic and explicit cache rates; incomplete usage/pricing produces unknown cost. There is no hardcoded current model or price. These response profiles do not supply billed currency amounts, so `reportedCost` stays unknown. `countTokens` supports the Anthropic request profile; the Chat Completions profile reports unavailable.

`countTokens(input)` prepares the request exactly as `stream` would, then for Anthropic posts model, system, messages and tools to the documented count endpoint ([Count tokens in a Message](https://platform.claude.com/docs/en/api/messages-count-tokens), read 2026-09-09) with `max_tokens`, `stream` and sampling fields dropped, returning `input_tokens` with `source:'provider'`; failures update account health like a probe. The OpenAI-compatible Chat Completions profile does not implement counting and returns `source:'unavailable'` with that reason; no local tokenizer estimate is fabricated.

Health distinguishes observed authentication failure, rate limiting and retry metadata, region errors, provider degradation and successful probes/generations. Generic transport failure stays unknown: it does not establish that the device is offline. Since 2026-09-09 the shared application keeps one adapter per connection, shows its health in the composer and in Providers, refuses to send while a credential is rejected or a retry time has not passed, treats the device's own offline signal as offline and re-checks from Providers; the application also schedules bounded background metadata checks as described above.

## Verification

The latest [reasoning-continuation qualification](../../docs/validation/reasoning-continuation.md) passes 94 provider tests, 29 checks per browser engine, and 19 native Tauri checks. The application regression is 65 groups per engine.

From the repository root:

```sh
npm test --workspace @quixi/providers
npm run test:browser --workspace @quixi/providers
npm run test:native --workspace @quixi/providers
```

Earlier [audio-input evidence](../../docs/validation/provider-audio-input.md): 77 Node tests, 25 checks per Chromium/Playwright WebKit, and 18 actual macOS Tauri checks pass on macOS 26.6.2. The [aggregate record](../../docs/validation/results/provider-audio-input-checks-macos.json) retains current browser/native reports and source hashes. The [browser snapshot](./tests/results/browser-macos-26.6.2.json) records runtime and source hashes; the earlier [26.5.2 snapshot](./tests/results/browser-macos-26.5.2.json) is retained. The first command typechecks implementation/tests and runs Node protocol/controlled HTTP tests. Browser acceptance builds a separate fixture page and uses fresh persistent profiles with actual SQLite/WASM/OPFS, reconciling a suppressed post-commit outcome, retaining partial/cancelled data, replacing an owner tab during a live request, and restarting the browser process. It writes `test-results/providers-browser.json`.

Native acceptance enables only Cargo `host-proof`, registers two synthetic loopback destinations outside caller-defined requests, and runs the same shared adapter proof through the real Tauri/native bridge with disposable OS-keychain entries. It writes `test-results/providers-native.json`; cleanup is part of success. The committed native snapshot is [macOS 26.6.2 provider evidence](../../tests/hosts/results/tauri-providers-macos-26.6.2.json), with the earlier [26.5.2 run](../../tests/hosts/results/tauri-providers-macos-26.5.2.json) retained. This establishes no Windows/Linux native-provider claim. Browser WebKit is not installed Safari.

## Optional live smoke procedure

Live requests remain opt-in and outside normal CI. Use a separate synthetic account, a reviewed current model/catalog entry and small output limit. Configure the exact native destination or an explicitly chosen browser relay using ADR0005; store its test credential through `HostClient` without putting it into a URL, fixture, log or committed file. Pass a synthetic prompt into the adapter, inspect the normalized terminal and raw usage manifest, and repeat once with cancellation after text arrives. Confirm one new Generation per attempt, transport cleanup and raw reconstruction after reopen. Delete the disposable credential afterward. Record date, model, transport/privacy, response IDs and observed costs without prompt/key/body logs. This repository has not executed that live procedure.

## Official protocol sources

Reviewed 2026-09-08; catalog facts and sampling parameters re-reviewed 2026-09-09. [OpenAI Chat Completions create](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create) and [Chat Completions reference](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions) define request/chunk identity, deltas and finish reasons. The [openai-node Chat Completions parameter source](https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts) documents `temperature` between 0 and 2, `top_p` nucleus sampling, up to 4 `stop` sequences and the recommendation to alter temperature or top-p, not both. [OpenAI streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses) describes incremental SSE delivery. The initial adapter intentionally implements Chat Completions for the plan's OpenAI-compatible scope; it does not claim Responses-only features.

[Anthropic Messages create](https://platform.claude.com/docs/en/api/messages/create) defines the top-level system prompt, output limit, message content, `temperature` (0–1, default 1.0), `top_p` and `stop_sequences`. It deprecates temperature and top-p for models released after Claude Opus 4.6; the reviewed Claude Haiku 4.5 snapshot (released 2025-10-15) still accepts them. It documents no stop-sequence count limit, so the adapter applies its own bound of 4 non-empty sequences of at most 1,024 characters for both protocols. [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) defines event ordering, cumulative usage and incremental tool JSON. [Stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) and [API overview](https://platform.claude.com/docs/en/api/overview) support terminal/error handling and the versioned `x-api-key` authentication profile.

Documentation correction (2026-09-10): OpenAI publishes [`POST /v1/responses/input_tokens`](https://developers.openai.com/api/docs/guides/token-counting) for Responses input. This adapter sends Chat Completions requests. It does not implement a corresponding counter or claim that converting its messages to Responses input yields an identical count. Unavailability is an adapter limitation, not a statement about all OpenAI APIs.
