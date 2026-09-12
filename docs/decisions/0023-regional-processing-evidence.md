# ADR 0023 — Evidence for regional processing constraints

Status: **Native connection setup, conversation policies and regional web relays
implemented, 2026-09-10. Integrated native constrained-attempt qualification remains open.**
See [native connection validation](../validation/native-regional-connections.md). The accompanying correction to token-count availability is
implemented and tracked in [validation](../validation/provider-capability-review.md).

## Requirement and current state

Product section 34 and plan 10 require usable region-constrained routing,
including ordered fallback and reusable alias snapshots. A control that refuses
every configured target would not complete that requirement. A successful
implementation must include a usable regional destination and refuse unknown or
incompatible destinations before transmitting conversation content.

The current [catalog](../../packages/providers/src/catalog.ts) reviews
`gpt-4.1-mini-2025-04-14` and `claude-haiku-4-5-20251001`.
[Native registrations](../../apps/desktop/src-tauri/src/registered_destinations.rs)
now include distinct global and US/EU OpenAI registrations. The [web connection configuration](../../apps/web/src/host/provider-connections.ts)
identifies a relay, privacy class and opaque upstream destination IDs. The
[host contract](../../packages/core/src/contracts/host.ts) now exposes the native
registration’s processing evidence separately from account eligibility. Neither an account-health probe nor the connection label
fills that gap. Native connection setup and credential-bound eligibility are now implemented.
Version-5 conversation profiles and the shared policy evaluator are now implemented;
see [policy validation](../validation/processing-region-policies.md).

## Dated external evidence

These official pages were opened and read on 2026-09-10; search summaries were
insufficient and, for OpenAI project requirements, out of date.

- OpenAI supports regional processing for the reviewed GPT-4.1-mini snapshot and
  Chat Completions in the US and Europe (EEA plus Switzerland). It documents
  regional project configuration and, alternatively, regional prefixed domains
  with eligible Global-project keys. Eligibility and retention requirements
  still apply. Regional storage does not imply regional processing; customer
  infrastructure and system data have separate limitations. Its regional
  pricing uplift applies to eligible models released from March 5, 2026, so
  that rule does not add an uplift to this 2025 snapshot. [Data controls](https://developers.openai.com/api/docs/guides/your-data)
- Anthropic separates inference geography from workspace geography. Haiku 4.5
  rejects `inference_geo`; models from Claude 4.6 support it. US inference for
  supported models costs 1.1 times standard token rates. Workspace restrictions
  can affect inference, but this app has no evidence of the configured
  account's restrictions. [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency)
- OpenAI publishes `POST /v1/responses/input_tokens` using Responses input.
  Quixi's implemented adapter sends Chat Completions input. The documentation
  does not establish that converting between those request formats preserves
  an exact count. [Counting tokens](https://developers.openai.com/api/docs/guides/token-counting)

## Decision for the implementation

The following is Quixi's design, rather than a claim that the providers expose
these application contracts.

Expose **required processing region** with explicit US and Europe (EEA plus
Switzerland) choices and an unrestricted default. Describe its scope as remote
processing of submitted conversation content, including a relay that reads the
payload. Do not call it a guarantee about every account record, local device,
network transit or data at rest. Preserve the product's broader region-routing
requirement; storage-residency controls, if later offered, need their own scope
and evidence rather than an overloaded region string.

Use a closed, optional `processingRegion` requirement (`us` or `eu`) in a new
canonical routing-profile version. Existing versions must reject this field;
new readers retain versions 1–4 with their existing meanings. The local alias
registry's closed validation must retain the same constraint, and application
must copy the reviewed snapshot. An omitted requirement is unrestricted;
malformed, unknown and unsupported values must never become unrestricted.
A schema or archive-protocol change depends on the actual persisted shape and
compatibility review; do not bump them solely because an opaque profile gains
an explicitly refused semantic version.

Regional destinations must have distinct stable connection, destination and
transport identities. For the first positive path, register OpenAI US/EU
Chat Completions destinations for the existing reviewed model; no model switch
or Anthropic protocol expansion is necessary. Keep origins in the host's
reviewed registry. Changing the selected region cannot rewrite an arbitrary URL
or silently reuse a credential bound to a different destination.

The host-owned evidence needs a version/revision, exact binding, processing
region, supported endpoint/model/input scope, dated provider source, and
upstream identity. Connection setup must distinguish documented provider
support from account eligibility. Where eligibility is operator/user-confirmed,
label it as that confirmation, bind it to the exact credential handle and
configuration, and invalidate it on replacement. Do not represent a successful
model-list request or manual region label as provider-verified geography.
Eligible Global-project keys remain an allowed setup; a region-specific project
is not a universal prerequisite. Missing required evidence refuses constrained
content transmission with a visible reason.

For web relays, the authoritative operator registration must identify the
actual regional upstream and the relay's own processing region. The relay must
enforce the registered upstream. A build-time client label alone cannot prove
that the deployed relay matches it. The protocol therefore needs a bounded
configuration identity/handshake that the host checks against its reviewed
configuration before admitting regional content. This establishes agreement
with the operator's declaration, not independent physical geolocation. The UI
must identify that trust and the operator. Unknown or mismatched intermediaries
refuse a configured region even when the provider route matches.

Keep region decisions in one shared evaluator, fed by current evidence. Apply
it to initial routing and every content-bearing operation: prompt counting,
send, regeneration, ordered fallback, summary counting and summary generation.
Counting also transmits the branch, so generation-only enforcement is
insufficient. Evaluate before blob staging, canonical message/attempt writes and
HTTP, and recheck the originating and current policy/evidence after asynchronous
work. A tightened policy must not be bypassed by fallback from an earlier run.
Do not silently relax a constraint to obtain a count or retry.

Scope review and count reuse to the selected regional destination and evidence
revision as well as the existing exact request and context scope. Region or
credential changes invalidate pending reviews and late counts. Record the
chosen region and evidence basis with routing/fallback audit events; portable
history preserves the policy and historical explanation, never credentials or
fresh permission to trust a newly configured connection.

Assess cost with the selected route's reviewed rates. Regional pricing must be
resolved before a request-cost cap is evaluated. Do not assume every regional
route has an uplift, or that rates reviewed for one model/route apply to another.
Unknown pricing continues to refuse a configured cap under ADR 0022.

## Alternatives and independent review

An independent agent reviewed the current registries and official documentation.
Its decisive findings were accepted: the existing OpenAI model gives a positive
regional path; unsupported Haiku parameters are not that path; and an unknown
relay defeats a claim about remote content processing. The review also added
counting and evidence-revision invalidation to the required transmission guards.
This is a design review, not an executed regional-routing test.

Rejected approaches include inferring geography from `local`/`direct_provider`,
matching `us` or `eu` in an arbitrary hostname, trusting a composer declaration,
adding `inference_geo` to Haiku 4.5, treating regional storage as inference
residency, and shipping only synthetic positive targets while calling the
feature complete. Adding a newer Claude model would introduce an unnecessary
capability/pricing qualification dependency for the first regional slice.

## Completion evidence

The native connection and conversation-policy increments below implement the
first positive path, closed field, aliases and workflow guards. The regional web
relay path is now implemented and proven with real relay/TLS fixtures. Keep plan
10 task 1 open until the remaining integrated native gate below passes.

| Requirement | Evidence required before claiming completion |
| --- | --- |
| Positive regional destination | Actual host dispatch to the registered US/EU route, exact reviewed model/body, synthetic stream and durable attempt; native behavior exercised natively |
| Unknown/wrong region, model, modality or eligibility | Zero content-count/generation HTTP, staging and canonical attempts; visible reason |
| Relay provenance | Matching configuration identity and upstream succeeds; wrong/unknown relay region, upstream or revision refuses |
| Initial routing and fallback | Ordered choice skips disallowed candidates; permitted regional route succeeds and records the evidence basis |
| Counting, regeneration and summaries | Same guard before content transmission and staging; late changed-policy/evidence results cannot authorize use |
| Compatibility and cost | Existing review scopes retained, current model/route prices used, no unsupported Haiku parameter emitted |
| Aliases and persistence | Reviewed snapshot survives edit/delete, process restart, fresh branch and portable restore; old profile versions reject new field |
| Local usability | Missing regional credentials or relay evidence leaves history/import/search/export usable |

Chromium/WebKit controlled tests can establish routing, wire behavior and
persistence. They cannot establish the physical location of a provider or relay,
real account eligibility, or native host support. Record those limits explicitly;
no paid request or private history transmission is authorized by this decision.

## Implemented native connection increment

The [native connection evidence](../validation/native-regional-connections.md)
records the first positive connection slice. Host evidence is version 1, tied to
fixed `openai-{us|eu}-gpt41-mini-2026-09-10` registrations and validated again by
the provider/controller boundary. Eligibility is explicitly user-confirmed,
kept only in the session, and bound to the opaque credential/configuration.
Image eligibility is separate so text use does not require claiming image
approval. Reopen/replacement, evidence mismatch and confirmation changes
invalidate adapters; dispatch checks again after asynchronous staging.

The browser and native proofs distinguish synthetic declarations, unchanged
production registry metadata and loopback dispatch. They establish neither
physical geography nor real account eligibility. This increment does not add
a region constraint to a conversation or restrict its other fallback targets.
Schema 12, archive protocol 4 and routing profile versions 1–4 are unchanged.
The remaining matrix above still gates plan 10 task 1.

## Implemented conversation-policy increment

[Policy validation](../validation/processing-region-policies.md) records the closed
version-5 field, reusable aliases, route selection and independent workflow guards.
The same native evidence check covers prompt and summary counting, generation,
regeneration and ordered fallback. A policy applies to every remote content
operation; count and summary controls use their explicitly selected connection.
They do not silently route elsewhere to obtain a count. OpenAI Chat Completions
counting remains unavailable even on a matching regional connection.

Initial attempt creation carries an expected canonical revision. After body
staging, a callback rereads the canonical context and exact policy before HTTP;
original/current region constraints and unchanged connection evidence must hold.
A changed policy, including a tightened cost cap, requires fresh review. Counts
also fence the revision and reread canonical state before exposing/caching a late
result. Summary reviews retain the exact policy JSON and connection evidence.
Native adapter checks independently retain the credential/modality boundary.

Region/evidence basis is retained in generation compatibility notes and routing
reasons. Historical notes distinguish US/EU from global OpenAI even after a
connection is removed or its review is updated; they provide switch provenance,
never current eligibility. The existing schema-12 JSON and archive-protocol-4
fields preserve exact versioned policy and audit records without a migration.
Older profile versions reject the new field; unrestricted profiles retain their
existing version selection. The local alias registry keeps closed validation.

The integrated browser proof has 42 groups per engine and explicitly synthetic
native declarations. The real native connection proof remains separate. Neither
establishes physical provider geography, and at that increment the regional relay handshake and
positive web path remained open. The subsequent increment below implements them;
integrated native constrained-attempt qualification remains.

## Implemented regional web relay increment

[Regional relay validation](../validation/regional-web-relays.md) records the real
browser host → authenticated relay → hostname-verified TLS fixture path, with
actual durable chat, regeneration and summary attempts. Optional per-region
HTTPS origins/operators permit separate US and European relays. The server
computes a normalized registration identity; an authenticated empty metadata
request establishes exact agreement before content dispatch, and the forwarding
header is checked before body reads or upstream connections. No client-selected
upstream URL is admitted. Operator declaration is explicit trust, not geolocation.

The host bounds metadata to 4 KiB/ten seconds, clones published evidence, cancels
probes on authorization changes/disposal and rejects stale capability results.
Revision counters prevent an older asynchronous token update from restoring a
cleared credential. A local HostClient dispatch callback rechecks canonical policy
and current credential eligibility after relay metadata awaits, immediately
before content fetch. It never crosses a wire or native IPC boundary. A late
change after attempt creation preserves a failed audit record with no content
request; initially inadmissible targets stay unavailable before attempt creation.

The metadata/body cache-header browser failures found during integration were
fixed at the relay boundary: browser transport headers are allowed and stripped
upstream, without admitting provider secrets or content on the metadata route.
Nine real-relay groups, 42 app regression groups and 11 settings groups per engine,
plus 257 Node tests and the host/relay regressions, pass with retained hashes.

At the web increment, the remaining matrix gap was **integrated native constrained-attempt execution**, now qualified below.
The earlier actual Tauri proof checks unchanged regional registry declarations,
then dispatches through separate loopback registrations that deliberately do not
claim a processing region. This does not establish a complete constrained native
AppRoot/controller/storage attempt through the registered regional HTTPS target.
Qualify that composition in an actual Tauri WebView using an isolated TLS fixture
that retains the regional hostname and verified certificate, without changing
production registration/admission rules or calling a real provider. Include
constrained generation/regeneration/summary, refusals and durable provenance.
Only then reassess plan 10 task 1 against the full matrix. The web increment does
not waive that host-specific requirement or the broader release/platform gates.


## Integrated native qualification

[Native attempt validation](../validation/native-regional-attempts.md) closes the
composition gate: 63 checks across five actual macOS Tauri processes exercise
the shared application, unchanged native regional registrations, scoped Keychain
and canonical worker with eight exact HTTPS fixture requests. The test-only
Cargo feature resolves the unchanged regional hostnames to loopback and adds
an ephemeral CA; it preserves hostname/certificate validation and cannot be
activated by production configuration. Actual untrusted-CA and wrong-hostname
requests fail before HTTP. The production window-admission rule remains intact.

The app verifies constrained US/EU sends, US regeneration/summary, initial
unknown/wrong regions, disallowed fallback, revoked eligibility and a canonical
policy change after staging. Only the latter uses an explicitly negative
scheduling wrapper; the original desktop dispatch callback performs the refusal.
Seven attempts and the exact frozen summary input survive process restart,
while reopened Keychain credentials require fresh eligibility confirmation.
Scoped cleanup succeeds. The validation maps this proof and retained browser,
relay, contract, cost and persistence evidence to every matrix row above.
Plan 10 task 1 is therefore checked. Actual summary fidelity, geography/account
eligibility and broader release/platform qualification remain independent gates.
