# 06 — Integrate the first live providers

**Status:** In progress (one recorded gate: live-provider qualification, a user gate; checkpoint batching landed 2026-09-13) — shared composition, bounded transport/persistence, image/PDF/audio mappings, account health, explicit Anthropic counting, provenance-bound reasoning continuation with manual thinking and named handling of provider-specific output parts implemented; scale and live-provider qualification remain

**Workstream:** A3 — provider adapters

**Depends on:** [02](./02_define_canonical_history.md), [05](./05_implement_host_capabilities_and_relay.md)

## Outcome

Support OpenAI-compatible and Anthropic generation through one typed adapter contract, preserving streaming output and provider-specific metadata.

## Product references

- [18. Generation](../product.md#18-generation)
- [19. Content parts](../product.md#19-content-parts)
- [21. Raw provider preservation](../product.md#21-raw-provider-preservation)
- [30. Provider adapters](../product.md#30-provider-adapters)
- [31. Typed capabilities](../product.md#31-typed-capabilities)
- [32. Account health](../product.md#32-account-health)
- [35. Privacy classes](../product.md#35-privacy-classes)
- [103. Track A — Product Core](../product.md#103-track-a--product-core)

## Tasks

- [x] Implement adapter discovery, authentication checks, model listing/descriptions, typed capabilities, request preparation, streaming, and response normalization. Both adapters authenticate through a model-list probe, describe models from the reviewed catalog, list the provider's models (Anthropic cursors followed through registered query parameters since 2026-09-09), prepare and stream requests and normalize events ([adapter tests](../../packages/providers/tests/adapter.test.ts), [browser and native proofs](../../packages/providers/docs/account-setup-validation.md)); Providers shows what a connection check discovered, reviewed models being the only selectable ones ([panel proof](../../packages/app/src/features/providers/tests/browser/run.mjs)).
- [x] Map canonical content parts into each provider’s supported request representation and preserve raw response data where practical. Surface unsupported mappings to the compatibility workflow instead of silently dropping content.
- [x] Normalize stream events for output parts, usage, completion, cancellation, partial failure, and provider errors. Define retry boundaries so an interrupted generation is not duplicated as a successful answer.
- [x] Implement account-health state transitions and capability-derived availability. Distinguish authentication expiry, rate limiting, degraded service, offline status, and unknown health. Adapters move between healthy, rate limited (with retry time), authentication expired, region unavailable, provider degraded and unknown from probes and generations ([adapter tests](../../packages/providers/tests/adapter.test.ts)); since 2026-09-09 the shared application keeps one adapter per connection, shows its health in the composer and in Providers, refuses to send while a credential is rejected or a retry time has not passed, treats the device's own offline signal as offline, and re-checks from Providers, proven with controlled 429/401 answers and an offline device in the [shared application acceptance](../validation/shared-app.md) plus the [health view tests](../../packages/app/tests/providers/health.test.ts). Background refresh is implemented under [ADR 0028](../decisions/0028-background-account-health.md); live-provider health remains in the remaining work below.
- [x] Capture token accounting, cached-token usage, estimated cost, and reported cost with explicit provenance. Store catalog/pricing metadata as updateable data rather than hardcoded UI assumptions.
- [x] Use controlled response fixtures for both protocols, including fragmented streams, tool records, reasoning metadata, and content with citations/files where supported.
- [x] Provide an opt-in live-provider smoke procedure with separate test credentials; normal CI must not require paid requests or real user history.

## Deliverables and interfaces

- OpenAI-compatible and Anthropic adapters in packages/providers, plus capability and normalized event contracts.
- Protocol fixtures, usage/cost metadata handling, and documented live smoke steps.

## Acceptance criteria

- [x] Both adapters produce a complete persisted Generation through the same consumer interface.
- [x] Stop/cancel releases transport resources and yields the correct terminal or partial state.
- [x] Malformed or interrupted streams retain received content and expose an intelligible failure.
- [x] Capabilities drive request validity; absent usage/cost values remain unknown rather than fabricated.

## Outstanding gates (added 2026-09-13 so the task list matches the remaining-scope notes below)

- [x] Measure and batch fine-grained canonical checkpoints at product scale without breaking byte bounds, durable raw retention or stop behavior. The current finite attempt ceilings are documented, not scale validation. — Implemented 2026-09-13: text deltas are sequenced at once but ride in the next checkpoint's commit (the following raw record, a non-text part or the terminal manifest) or a bounded flush (4 KiB, 16 mutations, or 100 ms of idle so a provider that pauses after a delta leaves nothing invisible; the providers browser proof's slow-stream cancellation found that need), so a streamed record costs one commit instead of two (1,002 commits for 1,000 records, was 2,002; `generation.test.ts` density, bounded-flush and idle-flush tests, 98 tests); raw bytes stay one verified blob per record, the terminal flush before sealing keeps every delivered delta in the committed prefix on stop or cancel, and checkpoint listeners are told only when a delta is durable. The providers browser proof and the shared-app proof pass on the batched path. Measured before the change (`packages/providers/tests/generation.test.ts`, "checkpoint density baseline"): a synthetic stream of 1,000 records with one 32-character delta each commits 2,002 batches: the creation, one verified raw checkpoint per record (1,001 with the manifest) and one text mutation per delta (the first delta of each 8 KiB text part creates it, later ones append), so two commits per streamed record and up to 200,000 per attempt at the 100,000-record ceiling. Batching design, not yet implemented: carry each record's pending text delta in the next raw checkpoint's commit (the mutation order text-then-raw preserves part order), flush the pending delta with the terminal manifest, and flush before sealing on stop or cancel so the committed prefix still holds every delivered delta; raw bytes stay one verified blob per record, so byte bounds and retention are unchanged. The providers suite's typecheck had been failing since the persistent-storage host capability landed (the health-races fake host lacked it); fixed with this measurement.
- [ ] Qualify the reviewed adapters against live provider responses. Every proof so far uses controlled HTTP fixtures; no real request is made without the user's authorization, so this is a user gate.

## Implementation evidence and remaining work

The [provider package](../../packages/providers/README.md) exports both adapters and `startGeneration`, using public `HostClient`/`StorageClient` only. Controlled fixtures verify fragmented UTF-8/SSE, tool JSON, reasoning/signatures, citations, unknown file artifacts, rate limits and cancellation. Actual browser tests publish raw blobs and canonical checkpoints in SQLite/WASM/OPFS, preserve separate attempt IDs and reconcile lost replies without duplicate mutations. Owner-tab termination does not restart the provider request. The actual macOS Tauri proof exercises both adapters through native HTTP and disposable keychain credentials at `tauri://localhost`. Fifty-one Node tests, 23 checks per Chromium/Playwright WebKit, and 16 native Tauri checks pass (native re-run 2026-09-09 on macOS 26.6.2 with the registered query parameters). The awaited durable-creation producer hook is verified to prevent dispatch on registration rejection or cancellation; both outcomes receive terminal canonical checkpoints. [Browser evidence](../../packages/providers/tests/results/browser-macos-26.5.2.json) records the measured runtime and source hashes.

Shared adapter/account/catalog selection and generation coordination are implemented in the [shared application](../validation/shared-app.md). Producer loss remains distinct from storage-owner changes; the existing producer/recovery evidence applies. This previously listed composition item is no longer unfinished work.

Remaining scope before this plan is complete:

- Token counting is implemented for the reviewed Anthropic request profile: since 2026-09-09 the Anthropic adapter counts the prepared prompt through `POST /v1/messages/count_tokens` ([Anthropic count tokens](https://platform.claude.com/docs/en/api/messages-count-tokens), read 2026-09-09) with generation-only fields dropped, and the composer offers "Count prompt tokens" as an explicit action for the exact draft and branch; the OpenAI-compatible Chat Completions profile reports that counting is not implemented, and no local tokenizer estimate is fabricated. The [2026-09-10 capability review](../validation/provider-capability-review.md) corrects the former provider-wide claim: OpenAI publishes Responses input counting, which this Chat Completions adapter does not implement. Model listing follows Anthropic cursors up to a page bound and reports an incomplete listing honestly (sections30–31).
- Content profiles are complete for the reviewed adapters. Provider-specific output parts are handled by name since 2026-09-11 ([ADR 0033](../decisions/0033-provider-output-parts.md), [validation](../validation/provider-output-parts.md)): citations travel as plain source notes, structured output as JSON text, refusal markers and the generation's own raw-only artifacts are omitted with a counted transformation, and import-derived artifacts stay refused by name. Reasoning continuation is implemented since 2026-09-11 ([ADR 0032](../decisions/0032-reasoning-continuation.md), [continuation validation](../validation/reasoning-continuation.md)) on the capture prerequisite ([ADR 0031](../decisions/0031-complete-thinking-block-capture.md), [capture validation](../validation/reasoning-block-capture.md)): manual thinking for the reviewed Haiku 4.5 profile with its documented budget and sampling constraints, receipts verified through the storage boundary and bound to generation, response, kinds, indexes and stream records, bounded raw-stream reconstruction for older generations, blocks carried first and unchanged to the producing model only, contract-permitted omission named per target elsewhere, and agreement across inspection, count, send, regeneration and fallback. Live acceptance of continued blocks and signature validity remain in the live-provider gate below. Verified WAV/MP3 audio input is implemented and qualified for the explicit GPT-Audio-1.5 profile ([audio qualification](../validation/provider-audio-input.md), [ADR 0030](../decisions/0030-provider-audio-input.md)); other reviewed profiles refuse audio by name. Verified blob-backed text is inlined with an explicit compatibility transformation; user File parts now map original PDF bytes for both reviewed adapters, while other formats are explicitly refused ([file contract review](../validation/provider-file-contracts.md), [ADR 0027](../decisions/0027-composer-file-inputs.md)). The summary proposal builder still requires explicit exclusion of File occurrences or another prefix. Raw-only output artifacts must not masquerade as imported/downloaded files (sections19,21 and31; continuation UI belongs to plan10). User-message images remain mapped for both adapters: the [image tests](../../packages/providers/tests/images.test.ts) cover exact base64 round trips and every explicit issue, and the [shared application](../validation/shared-app.md) sends a verified PNG attachment through the production worker as an Anthropic image block with its exact bytes.
- Keep the reviewed catalog and pricing data current. Background account-health refresh is now implemented and qualified separately in [background health](../validation/background-health.md): one automatic metadata probe, visibility/connectivity/busy gates, bounded cadence and retry backoff, credential rejection pause, cancellation and preservation of newer health observations. Both catalog entries now carry dated per-million-token prices read from the providers' published rates on 2026-09-09 ([pricing tests](../../packages/providers/tests/pricing.test.ts)), so completed attempts record an estimate; billed amounts stay unknown until a provider reports them. Health, availability gating and the device offline signal are proven with controlled answers; no live provider has established a real health transition or a real usage report. No live provider smoke or paid request has run (sections30–32).
- Measure/batch fine-grained canonical checkpoints at product scale without breaking byte bounds, durable raw retention or stop behavior. The current finite attempt ceilings are documented, not general scale validation.

PDF composer integration passes 44 shared-application groups per engine, including exact-byte portable restore/regeneration and process restart ([composer files](../validation/composer-files.md), [current reports and source hashes](../validation/results/composer-files-checks-macos.json)). Regional adapters intersect their capabilities with reviewed regional modalities, so general PDF support does not enable regional file dispatch.

Run `npm test --workspace @quixi/providers`, `npm run test:browser --workspace @quixi/providers`, and on the tested macOS host `npm run test:native --workspace @quixi/providers`. The package README contains the exact integration contract, official sources and optional live smoke procedure. Native evidence is [tauri-providers-macos-26.6.2.json](../../tests/hosts/results/tauri-providers-macos-26.6.2.json); browser results are retained as [browser-macos-26.6.2.json](../../packages/providers/tests/results/browser-macos-26.6.2.json).

## Background health increment — 2026-09-10

[Background health](../validation/background-health.md) qualifies one automatic,
first-page model probe at a time for connected, eligible accounts. The scheduler
respects visibility, connectivity, foreground work and provider retry times;
credentials rejected by the provider pause automatic checks. Explicit model
discovery is preserved. Abort signals cancel transport and release late bodies,
and observation revisions prevent stale probes from replacing newer response
health. Current credential/configuration checks prevent stale adapter dispatch.

The final proof passes **61 app groups per browser engine**, **23 provider
transport checks per engine**, **11 settings checks per engine**, **190 unit
tests** and `npm run check`. The [aggregate evidence](../validation/results/background-health-checks-macos.json)
verifies the app's 100 unchanged source hashes and the auxiliary reports.
This closes the background-refresh implementation gap; live-provider health,
remaining content profiles, catalog maintenance and scale work above stay open.

## Audio-input increment — 2026-09-10

The general OpenAI connection now offers an explicit GPT-Audio-1.5 choice.
Verified WAV/MP3 bytes flow from picker/drop through canonical Audio records,
compatibility inspection, request mapping, regeneration and portable restore.
Unsupported models/protocols refuse the request; regional model allowlists stay
independent. Requests explicitly select text output, and mixed audio/text price
estimates remain unknown. Summary proposals still require reviewed audio exclusion.

[Qualification](../validation/provider-audio-input.md) passes **63 application
groups per engine**, **25 provider transport checks per engine**, **18 actual
macOS Tauri checks**, **231 unit tests** and `npm run check`. The
[aggregate evidence](../validation/results/provider-audio-input-checks-macos.json)
retains source hashes, reports, screenshots and failed-attempt explanations.
Live codec/account acceptance, reasoning continuation and product-scale transport
qualification remain open; this increment does not complete plan 06.

## Reasoning capture prerequisite — 2026-09-10

Complete Anthropic thinking and redacted blocks now receive bounded, versioned
raw receipts only after matching block closure. Exact text, signatures and opaque
data retain their original values, response identity, provider index and source
record range. Blob publication and canonical reference commit atomically;
incomplete or malformed blocks never receive a complete receipt. Original raw
stream chunks remain independently retained.

[Capture qualification](../validation/reasoning-block-capture.md) covers **86
provider tests**, **28 browser transport/persistence/archive checks per engine**,
**19 native Tauri checks**, the **63-group shared app regression per engine** and
`npm run check`. This closes the capture prerequisite only. Capability-driven
thinking parameters, provenance-bound request mapping, compatibility/count/send/
regenerate agreement and archived continuation are still required.

## Reasoning continuation increment — 2026-09-11

The reviewed Anthropic catalog declares the `anthropic-manual-haiku-4.5`
profile and permits `thinkingBudgetTokens`; the composer's "Thinking budget"
control appears for that model only and refuses, with the reason and without
writes or HTTP, a budget below 1,024, at or above the output limit, a set
temperature or a top-p outside 0.95–1. A thinking-enabled attempt sends
`thinking.enabled` and records signed/redacted receipts beside their markers.
Every later request on the producing model loads those receipts through the
storage client, binds them to the message's generation, response, block kinds,
ascending indexes and exact opening stream records (or reconstructs them from
retained raw segments within 8 MiB), and carries the blocks first and unchanged
through count, send and regeneration; another provider or model receives none
of them, with the omission named in the switch report and portability, as the
contract permits outside tool use. Receipts and stream locators are listed as
response source records and never sent.

[Qualification](../validation/reasoning-continuation.md) passes **94 provider
tests** (8 new), **29 browser checks per engine** (1 new: storage-loaded
receipts equal to a raw reconstruction, mapped into an accepted count and
generation over actual HTTP), **65 shared-application groups per
engine** (2 new, including the fresh-process follow-up), **85 switching unit
tests** (4 new), **19 native Tauri checks** and `npm run check`. Live
acceptance of continued blocks, signature validity, thinking quality and
billing remain unestablished by controlled fixtures.

## Provider output parts increment — 2026-09-11

Citation, StructuredData and raw-only ProviderArtifact output parts no longer
receive the generic refusal. The workflow sends a citation as a plain
`[Source: label — url]` note, other structured output as JSON text, and omits
refusal markers and this generation's own stream artifacts, counting each
transformation for the switch report, portability and the recorded switch;
import-derived artifacts stay refused by name. [Qualification](../validation/provider-output-parts.md)
passes **95 provider tests**, **89 switching tests**, **66
application groups per engine**, **29 provider browser checks
per engine** and `npm run check`.

## Boundaries and sequencing

Routing and cross-provider continuation belong to plan 10. Historical export formats stay in plan 04. Review current official provider documentation when implementing these adapters; the product spec is not a frozen API protocol.

[Back to the roadmap](./README.md)
