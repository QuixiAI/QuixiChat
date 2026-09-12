# Implementation roadmap

These 26 plans break the full [product specification](../product.md) into bounded
work packages for the current [monorepo architecture](../architecture.md). The
repository is being implemented from its initial scaffold. The preserved Gemma
prototype is reference material, not an implementation of these milestones.

Current execution scope: **23 plans: 01–14 and 16–24**. The user deferred OCR and
Cloud on 2026-09-08; plans **15, 25 and 26** remain future work and do not gate this
goal's completion. PDF text extraction and document search remain included. The
[goal prompt](./GOAL.md) records these scope changes.

Completed plans: **02, 03, 14, 16, 17, 18 and 20** (canonical contracts and storage,
document extraction/search, embedding reference, scalar encoder, SIMD and bounded
embedding scheduler). Plans **01, 04, 05, 06, 07, 08, 09, 10, 11, 13, 19, 21 and 23** have work underway
for platform qualification, imports, host adapters, providers, lexical search,
shared UI, archives, provider switching, browser-extension import, WebGPU release qualification, semantic search and diagnostics. Three other in-scope plans remain planned; OCR and the two Cloud plans are deferred. Detailed evidence and
remaining gates live in each numbered file; this summary does not count a working
feature slice as a completed plan. The [storage matrix](../validation/storage-proof.md)
separates measured behavior from outstanding platform and release gates.

Current integration work: extraction memory and broader release qualification after structured PDF layout, durable fallback notices, macOS extraction and exact image/part search navigation passed acceptance. Portable restore and explicit replacement UI are implemented. Original-source tokenizer offsets are implemented in the independently verified CPU 1.0.2 artifact; semantic chunk integration remains future work. The [shared application](../validation/shared-app.md) now connects provider imports, generation coordination, rich content, lexical search and resumable portable/open exports. Sixty-six controlled checks per browser engine cover the integrated app, including citations and provider-specific output records carried as named transformations, manual thinking for the reviewed Haiku 4.5 profile with signed and redacted blocks continued from verified receipts on the producing model only, a reviewed provider switch shown as a compatibility report and recorded as a conversation event, a per-conversation routing profile that chooses the route before the first attempt from health, capability, privacy, context and cost facts, an imported ChatGPT conversation continued with the Anthropic connection without rewriting its records, a live portability status with one reason per configured target, a stored fallback that continues a failed or partial attempt with another connection as a separate recorded attempt, capability-bound output limits, provider-driven connection health with availability gating and the device offline signal, reported tokens with reviewed-price estimates per attempt and conversation totals, on-request prompt token counts through Anthropic's count endpoint, explicit sibling-branch navigation that survives a browser restart, a credential-boundary scan of records, requests, exports and storage, catalog-declared temperature/top-p/stop-sequence settings, quote in reply, a keyboard-only core workflow with boundary-only streaming announcements, a verified PNG attachment sent as a provider image block, composer image attachment through the host picker and drag and drop with refusals, removal and archived preview, continuous text across raw streaming checkpoints and local usability with invalid relay configuration; the broader accessibility and host/release-scale gates remain open. The [production client acceptance](../validation/archive-client.md)
now covers canonical transactions and verified blob publication across tabs,
lost replies, owner takeover, many-part normalized import publication and
browser-process restart, independent producer loss recovery and exact FTS rebuilds.
The [blob acceptance evidence](../validation/blob-storage.md) covers the byte
layer plus private canonical transaction/publication tests; the full storage
failure/release matrix remains outstanding. Host adapters and the implemented
relay follow [ADR 0005](../decisions/0005-host-capabilities.md). Provider streaming
and persistence pass controlled HTTP browser/native tests. ChatGPT, Claude and
ZIP parsing pass repository acceptance and actual production-browser import,
owner-takeover and process-restart checks. WebGPU passed the recorded Apple-family browser matrix; wider hardware qualification remains open. The scheduler's plan-20 acceptance is complete; SIMD performance
evidence is explicitly limited to the exercised host under development load.
The first usable milestone still needs the remaining provider and accessibility acceptance, export scale/cross-host qualification and the prerequisite release gates.
Current interface work: PDF attachments and all five persisted interaction preferences are qualified through the shared application. The remaining interface work is the accessibility audit, onboarding and themes. Plan 03's migration-failure recovery path is now designed in [ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md): both host entries render a typed, retryable startup outcome (proven in the built web app with denied storage in Chromium/WebKit), and the next steps are the byte-level rescue export through a retained-style reader, restore validation of rescue archives (plan 09), and read-only history at a compatible ledger prefix. That proof exposed and fixed an interrupted-first-run fault: a namespace directory left without its pool database made every later start refuse; default initialization now creates only a namespace with no database and no blob files, proven end-to-end in Chromium with a real retry recovery. The byte-level rescue export now exists as a storage client and dedicated worker with retained Chromium/WebKit evidence (exact database and blob bytes, future-ledger rescue, refusals, unchanged files, explicit restore refusal). The startup outcome view now offers that export through host staging and the host save flow, proven end-to-end in Chromium. Rescue restore now works at exactly this build's schema, cleaning the raw database into a fresh candidate and dropping unreferenced blob files, with retained Chromium/WebKit evidence including the live default archive. The outcome view now also browses a compatible archive's history read-only through the retained reader (Chromium end-to-end). Remaining recovery work: the migration-aware candidate upgrade with fresh review binding that would let older-prefix rescue archives restore, and native exercise of the desktop entry. Plan 08's responsiveness criterion is now closed by a two-engine scale scenario (2,001 conversations, a 2,000-message thread, bounded reads throughout), which also fixed the worker running an indexing slice inline after every foreground read. Plan 04's application workflow task and all four acceptance criteria now carry production-panel evidence in both engines (repeat import without duplicates, changed-source revisions, pause/restart/discard, lexical usability without a provider). Malformed message records are now skipped with a visible notice instead of failing the import, and an unavailable original source at resume is explained. Plan 04's only open task is official-export qualification, which needs redistributable current ChatGPT and Claude export captures that only the user can supply or authorize. Plan 03's four acceptance criteria and its migration task are now ticked against the SQL, blob, client, scale and recovery evidence, with the shared app wording storage boundary failures as actionable outcomes; its blob orphan-detection task is now qualified by the bounded Storage health inventory (plan 23); routing profiles and aliases now fit the existing canonical and local metadata fields with compatible versioned payloads. Plan 06 now maps user-message images for both adapters from verified attachment bytes, proven in the shared app on a seeded PNG; PDF file mapping is now implemented under [ADR 0027](../decisions/0027-composer-file-inputs.md); unsupported formats remain explicit refusals. The composer now attaches images through the host file picker or drag and drop as verified staged blobs with previews, refusals and removal, publishing them with the message and sending them as provider image blocks (nineteen checks per engine); dropped files reach hosts through a new `HostClient.adoptFiles` method covered by the browser host fixture suite, while the desktop window is configured for HTML5 drops but not yet exercised natively. Rescue and portable archives from schema 8 onward now restore through a migration-aware candidate upgrade: the fresh-schema copy builds the isolated candidate at this build's schema before validation and review, the review names the upgrade, and lower, newer or tampered ledgers are refused by name, with a genuine schema-8 rescue (retained proof) and a genuine schema-8 portable (archive proof, revalidated across owner restart) as evidence. Account health now reaches the shared application: one adapter per connection records what the provider last answered, the composer shows it with the reason and evidence, sending is refused while a credential is rejected, a retry time has not passed or the device is offline, and Providers shows and re-checks the same health (twenty checks per engine); the check also fixed sending after a failed attempt, whose empty assistant turn the request now omits. Model discovery is complete: registered routes may permit named query parameters across the core contract, browser host, relay wire (`X-Quixi-Query`) and native host, the Anthropic adapter follows listing cursors at the documented page size, and Providers reports listed, reviewed and unreviewed models from a connection check. Token and cost displays are in place: the catalog carries dated published rates, completed attempts record estimates labelled as such, and the conversation header sums attempts, tokens and priced estimates from a storage-worker aggregate. Prompt token counting now runs through Anthropic's documented count endpoint on request, registered on every host, while the OpenAI Chat Completions connection states that counting is not implemented. The plan 08 review ticked branch navigation and the reload criterion on new sibling-navigation and restart proofs, extended the content proof to citations, reasoning, structured data, provider artifacts, audio and notes, and left rendering open only for syntax coloring and audio playback, and the either-provider criterion open until stop, edit and search run under the Anthropic connection. Fenced code is now coloured by a bounded, dependency-free tokenizer for a fixed language set, proven in both engines beside a plain unknown-language block, which closes plan 08's rendering task. Plan 08's either-provider criterion is now closed: stop and regenerate are proven under both connections and search finds text streamed by the Anthropic connection. Plan 08's composer task is complete; the keyboard/focus/screen-reader task shared with plan 13 remains open. Code copy now runs through a host clipboard capability on both hosts, shown only when the host reports it available and proven with a Chromium readback. The plan 05 review ticked five of seven tasks and all four acceptance criteria on the existing browser, native and relay evidence plus two new proofs: a credential-boundary scan in the shared app and a transport-identification test in the settings controller. Plan 05 stays open for other native callback platforms, live-provider qualification and notifications; macOS native callbacks and browser OAuth now pass their separate synthetic qualifications. Plan 10's first slice is in: the provider adapters report what the request mapper would carry, refuse or constrain for a target model from the same mapping that builds the request, the chat workflow adds its own omissions and transformations, the composer shows that report when the selected connection or model differs from the last attempt and refuses a consequential switch until a review scoped to the exact report is ticked, and the send records a `ProviderSwitch` event with the user turn that survives a restart ([ADR 0017](../decisions/0017-provider-switch-inspection.md), twenty-six checks per engine). That slice also fixed inspection and prompt counting after a stopped attempt, which reused the stopped run's cancellation flag. The switch report now carries the target's context window, requested output and input room with the on-request count's fit or excess, and the reviewed rates with an input estimate and a bounded output estimate, all from the catalog and the existing count endpoint; counting stays explicit because it sends the branch to the target, and a count over the room refuses to send until the user chooses an explicit compaction action (four switch-context unit tests, the extended twenty-sixth check per engine). Plan 10's inspector task is ticked with its limits recorded. Portability statuses are in: the open conversation shows Fully portable, Portable with transformations, Provider-dependent, Blocked or Unknown for its active path across every configured target, with one reason per target and what is never sent, recomputed live from the same compatibility reports (five unit tests, twenty-seven checks per engine); plan 10's portability task is ticked, with library-wide counts left to plan 12. Fallback is in: a conversation stores one fallback target and a privacy allowance in its routing profile, a failed or partial primary attempt continues with that target as a separate attempt when its health, privacy class and compatibility report allow, every refusal states its reason, a user stop never falls back, and the `AutomaticFallback` event is committed with the fallback attempt (six unit tests, twenty-eight checks per engine); plan 10's fallback task and its privacy/capability/partial-output criterion are ticked. Plan 10's first acceptance criterion is now closed: an imported ChatGPT conversation (the synthetic export, through the production import panel) continues with the Anthropic connection as a reviewed switch from its import origin, with the artifact-bearing branch shown blocked, the text branch chosen, its sketch without exported bytes sent as a reviewed note (the proof exposed and fixed a hard block on images whose bytes this device does not hold), and every imported record unchanged (twenty-nine checks per engine). Routing profiles are in per conversation: an optional name, ordered fallback candidates, tool/image/context/cost requirements and the privacy allowance, with the route chosen before the first attempt from account health, catalog capabilities, the counted prompt's cost and the compatibility report, every examined candidate's outcome shown, a routed attempt recorded as an `AutomaticFallback` event, and the remaining candidates tried in order after a failure (five routing unit tests, thirty checks per engine). Plan 10's reusable aliases and reviewed application are now implemented; its routing task is now qualified by the integrated native constrained-attempt proof under ADR 0023. Per-attempt request cost and explicit fresh branching are now implemented; actual summary fidelity qualification remains open (task 5); plan 03's routing-state migration question is closed because complete version-3 profiles fit its existing schema-8 JSON field and aliases fit local metadata; plan 09's cross-host restore gate waits on a native host run.

Latest completed iteration (2026-09-12): **browser-scale sqlite-vec
measurement and the coarse-stage amendment** (plan 22, [ADR 0036](../decisions/0036-compressed-vector-retrieval.md)
"Browser measurement"). `perf/retrieval/browser-knn/` runs the pinned SQLite
WASM on OPFS in Chromium and WebKit at 100k and 500k vectors and records
float KNN, int8 coarse, coarse→rerank, page-cache misses, memory, cold reopen
and queries interleaved with publication batches. Two findings: the int8 scan
is CPU-slower than the float scan in this sqlite-vec WASM build (100k: 56 vs
42 ms Chromium, 78 vs 43 ms WebKit; 500k: 282 vs 211, 388 vs 219), and vec0
point lookups read whole 1024-vector chunks, so the first rerank shape
(`rowid IN`) scanned the float table and even the corrected join costs more
pages than the exact scan unless the float table uses `chunk_size=16`.
Memory is not the constraint on the OPFS path (SQLite high-water 29 MB at
500k). The production rerank now joins on vec0's point plan, and the coarse
stage is off by default (`SEMANTIC_COARSE_THRESHOLD = null`; the status and
panel say so) while the projection and its lifecycle stay tested and
enablable per repository. Plan 22 keeps six of eight tasks ticked; open: the
1M browser run, a binary Hamming pre-filter (`bit[384]`, candidate sets in
the thousands, quality via `compressed.mjs` with larger candidate counts)
as the coarse stage that could actually beat the float scan, and the filtered
hybrid rerun. Completed plans remain **7 of 23**.

Previous completed iteration (2026-09-12): **int8 candidate index in storage**
(plan 22, [ADR 0036](../decisions/0036-compressed-vector-retrieval.md)
"Implementation"). The semantic namespace is now version 2: every published
float vector is also written to a sqlite-vec `int8[384]` projection
(`int8-fixed-symmetric-v1`, stored scale, same transaction), a version-1
namespace upgrades in place and bounded maintenance backfills its projection,
a projection with another representation or scale is discarded at open and
rebuilt, and above 20,000 vectors with a complete projection the semantic path
takes the top 500 int8 neighbours and reranks them by exact float32 distance
before the unchanged bounded-candidate/RRF path; smaller or incomplete indexes
keep exact retrieval and `status.projection` says which is in force. A new
storage test compares the coarse ranking with the exact ranking on a lowered
threshold and exercises upgrade, backfill, mismatch and deletion; the browser
semantic proof asserts the projection in both engines; the app panel shows the
candidate index. A pinned-SQLite measurement in Node at 100k vectors found the
int8 scan slower than the float scan (56 ms versus 21 ms median), so the
projection's benefit at this scale is memory and I/O, not CPU — that is the
question the browser measurements must answer next. Plan 22 has six of eight
tasks ticked; open: browser-scale measurements (Chromium/WebKit sqlite-vec
KNN latency, OPFS reads, memory under foreground and backfill load at
100k/500k/1M) and the filtered hybrid rerun with the chunk-size sweep.
Completed plans remain **7 of 23**.

Previous completed iteration (2026-09-12): **compressed-retrieval benchmark and
decision** (plan 22, [ADR 0036](../decisions/0036-compressed-vector-retrieval.md)).
`perf/retrieval/compressed.mjs` scales the real production-chunker vectors to
100k/500k/1M with seeded distractors from the real distribution and measures
product §81's pipelines. int8 coarse retrieval (global symmetric scale, the
form sqlite-vec's `int8[384]` consumes) keeps 97–99% of the exact float
neighbours at every size and reproduces every judged float metric after a
float32 rerank at 200–1000 candidates; sign-bit binary overlap collapses to
0.22/0.14 at 1M and loses judged recall at 200 candidates; int8 as the final
ranking loses Recall@10. Decision: int8 coarse + float32 rerank over 500
candidates, binary rejected as a sole coarse stage, representation metadata and
rebuild rules recorded. Plan 22 has three of eight tasks ticked; open: the
storage implementation (sqlite-vec int8 projection, rebuild path,
coarse→rerank switch), browser-scale measurements (latency, OPFS reads,
memory, foreground/backfill load) and the filtered hybrid rerun. Completed
plans remain **7 of 23**.

Previous completed iteration (2026-09-12): **production-chunking parity
measurement** (plan 21, plan 22 input). `perf/retrieval/production-chunker.mjs`
reruns the plan 16 exact-FP32 quality measurement with the production
structural chunker (256-token budget, pinned offset tokenizer) and the WASM
SIMD encoder: 658 chunks against the reference 659, and identical Recall@5,
Recall@10, MRR and judged Recall@100/500. Seven changed top-ten orderings were
investigated: each moves only the corpus's single multi-chunk document among
nonrelevant positions. Recorded in [production-chunker.json](../../perf/retrieval/production-chunker.json)
and the [benchmark README](../../perf/retrieval/README.md#production-chunking-parity--2026-09-12).
Plan 21 now has seven of eight tasks ticked (open: an in-app GPU-loss fallback
observation and a hardware-adapter Chromium run). Completed plans remain **7 of 23**.

Previous completed iteration (2026-09-12): **first-run onboarding and storage
status** (plans 13/21, [ADR 0018 addendum](../decisions/0018-local-preferences-and-routing-presets.md#onboarding-state--2026-09-12)).
The device-local preference row is version 3 with `onboardingCompletedAt`
(v1/v2 rows normalize without writes); `setOnboardingState` is its writer. The
shared application renders product §94 steps 1–5 on the landing until finished
or skipped: local-storage disclosure, a capability check read from storage
diagnostics, host capabilities (including the new `persistentStorage`
capability and `requestPersistentStorage`, unavailable on desktop by reason),
lexical search status, WASM SIMD, a WebGPU adapter probe and host model
presence; bring-history links (extension, export, archive); configured
provider connections; and the semantic step 5 that enrols through the plan 21
controller. The §13/§14 storage block (persistence grant with the browser's
actual answer, usage/quota, ownership note, Export backup) also heads Storage
health, and Preferences can show the setup again.
[Validation](../validation/onboarding.md): 69 core tests, 12 preference
controller tests and **8 onboarding checks per engine** (Chromium and WebKit,
retained in [onboarding-checks-macos.json](../validation/results/onboarding-checks-macos.json));
both headless engines refuse the persistence request, shown as not granted; the
full application proof passes **84 groups per engine** ([retained](../validation/results/onboarding-app-macos.json)).
Plan 13's onboarding and storage-status tasks and its actual-capabilities
criterion are ticked; plan 21's onboarding item is closed (its task 7 ticked).
Completed plans remain **7 of 23**.

Previous completed iteration (2026-09-12): **browser-extension import** (plan 11,
[ADR 0035](../decisions/0035-browser-extension-import.md)). The provider review
withholds a Claude web extractor under Anthropic's consumer terms and ships a
user-driven ChatGPT web extractor on Chromium MV3 under the product owner's
2026-09-12 decision (OpenAI's terms text answered HTTP 403 and remains to be
recorded). `packages/core/src/contracts/extension-import.ts` defines the
versioned `ProviderImportBundle` envelope and the page transfer (pairing code,
256 KiB chunks, four in flight, acknowledgements, resume from the committed
offset, cancel, staged/imported outcomes). The web host owns the listener,
pairing and digest-verified staging (`HostCapabilities.extensionTransfers`,
`HostClient.extensionBridge`; desktop reports it unavailable); the shared
import panel shows the pairing code and the pending offer and imports only on
an explicit accept, with `ImportSource.method = "extension"`. `apps/extension`
is a buildable MV3 extension (import page with progress/cancel/reconnect,
idempotent bridge and ChatGPT extractor content scripts, per-account "only new"
checkpoints) built as part of `npm run build`. [Validation](../validation/extension-import.md):
68 core tests, 6 extension unit tests, the import-panel proof at **17 checks
per engine** (Chromium and WebKit, retained) and the real extension end to end
in Chromium against a synthetic ChatGPT origin (**5 checks**: expired session,
changed shape, full extraction/offer/accept/import with provenance and search,
nothing-new checkpoint, single new conversation), plus `npm run check`.
Qualification found and fixed concurrent chunk handling in the receiver and
duplicate listener registration on repeated content-script injection. Plan 11
has five of seven tasks and three of four criteria ticked; open: a real
chatgpt.com account run (the user's acceptance), desktop pairing, Quixi-side
retry and report integration, other browsers. Completed plans remain **7 of 23**.
The whole monorepo was committed and pushed to `origin/main` on the user's
instruction (one commit rebased onto the README update).

Previous completed iteration (2026-09-11): **semantic indexing and hybrid search**
(plan 21, [ADR 0034](../decisions/0034-semantic-indexing-and-hybrid-search.md)).
Production chunking now uses the frozen Arctic tokenizer with a 256-token budget
(the derived index version names it and upgraded archives rebuild their lexical
epoch automatically). Vectors live in a separate `quixi_semantic_*` namespace on
the pinned sqlite-vec build, keyed by the SHA-256 of the exact embedding input
with generations, five-minute claim leases and per-item rejection of stale,
changed, duplicate or malformed publications. `searchArchive` serves Exact,
Semantic and hybrid Best (RRF k=60 over the top 256 BM25 hits and a bounded vec0
candidate set) with §46 explanations. `@quixi/quixi-embed/service` adds the
dedicated embedding worker (pinned-asset verification, OPFS model copy,
WebGPU → SIMD → scalar selection) and `@quixi/search` the bounded claim → embed
→ publish loop; the shared application gains a Semantic search panel with the
§72 status block and the five §73 controls, a search-mode selector and origin
labels, and hosts serve the separately provisioned model under `/models/`.
[Validation](../validation/semantic-search.md) passes **41 search-package
tests** (9 semantic storage, 5 indexer) and **10 shared-application checks per
engine** with the real model (Chromium on WASM SIMD, WebKit on WebGPU FP32),
retained in [semantic-search-checks-macos.json](../validation/results/semantic-search-checks-macos.json);
the full application proof passes **76 groups per engine**
([retained](../validation/results/semantic-search-app-macos.json)), the storage
client, extraction-search, search-navigation, document UI, conversation-search
and documents persistence browser suites pass, and `npm run check` passes. Qualification found and fixed a preflight-closure
lifetime bug and a WebKit page-process crash when a worker that held a WebGPU
device is destroyed (the service now parks workers). Plan 21 has six of eight
tasks and all four acceptance criteria ticked; open: the onboarding step 5 prompt
(plan 13's flow), an in-application GPU-loss fallback observation, and
production-chunker relevance measurement on the plan 16 corpus. Completed plans
remain **7 of 23**. The documents persistence proof's stale schema-10 assertion
was corrected to the current schema 12.

Previous completed iteration (2026-09-10): **complete signed/redacted thinking-block
capture** (plan 06 prerequisite). Protocol review found that a reasoning marker
and a nearby TCP chunk do not identify a complete signed block. The normalizer
now assembles exact provider values through block closure, and the consumer
atomically publishes a verified raw receipt with generation/response/index and
source-range metadata. Original stream evidence stays intact; incomplete,
malformed and oversized blocks cannot become complete receipts.
[Qualification](../validation/reasoning-block-capture.md) passes **86 provider
tests**, **28 browser transport/persistence/archive checks per engine**,
**19 native Tauri checks**, **63 app groups per engine** and `npm run check`.
[Retained evidence](../validation/results/reasoning-block-capture-checks-macos.json)
retains 140 verified source hashes and 10 artifacts, including original and restored
receipt hashes. Completed plans remain **7 of 23**.
Reasoning continuation is still unfinished: this iteration delivers the durable
capture prerequisite, with dispatch and capability controls next.

Previous completed iteration (2026-09-10): **verified provider audio inputs**
(plan 06). The general OpenAI connection offers GPT-Audio-1.5 explicitly; WAV/MP3
picker/drop attachments retain original bytes through storage, compatibility
inspection, dispatch, regeneration, portable restore and restart. Unsupported
models/protocols refuse audio by name, regional model allowlists stay explicit,
and requests select text output. Audio pricing stays unknown under the current
flat-rate contract. [Qualification](../validation/provider-audio-input.md) passes
**63 app groups per engine**, **25 provider transport checks per engine**,
**18 actual macOS Tauri checks**, **231 unit tests** and `npm run check`.
The [aggregate record](../validation/results/provider-audio-input-checks-macos.json)
retains 134 verified source hashes and 29 artifacts. Failed attempts exposed a stale target count,
enlarged-text portability overflow, an attachment-test staging race and an unbound
UUID callback in the host fixture; each correction is documented and rechecked.
Completed plans remain **7 of 23**. Reasoning continuation, live-provider behavior,
summary fidelity, accessibility and platform/release-scale gates remain open.

Previous completed iteration (2026-09-10): **resumable initial blob verification
for lexical indexing** (plan 07). The owner retains a private hash cursor and
shares a 128 KiB admission budget between verification and decoding. Unverified
bytes cannot enter chunking; cancellation, source changes, shared foreground
reads, corruption and owner restart preserve canonical history and sync records.
[Validation](../validation/incremental-search-verification.md) passes **61 app
groups per engine**, **29 production-client checks per engine**, the complete
blob/catalog suite with **seven new verification checks per engine**, **135
distinct unit/SQL tests**, six fixture TypeScript projects and `npm run check`.
Both engines complete 16 foreground reads during incomplete verification of a
2.18 MB source. The [aggregate record](../validation/results/incremental-search-verification-checks-macos.json)
retains 141 source hashes and 15 artifacts. The first browser attempt exposed a
second SQLite initialization in the test worker; shared initialization and worker
error propagation fix the harness, and the failed evidence is retained. Plan 07's
initial-verification item is ticked. Completed plans remain **7 of 23**; release
scale/relevance, portability filtering and semantic integration remain open.
Plan 06's stale background-refresh headline is also corrected to match its proof.

Previous completed iteration (2026-09-10): **bounded background account-health
refresh** (plan 06). The session controller checks connected, eligible accounts
through one bounded model-metadata probe, with visible/online/idle admission,
30-second initial delay, five-minute healthy cadence and capped failure backoff.
Rejected credentials wait for an explicit check or reconnect. Foreground work
cancels a probe; cancelled or late observations cannot overwrite newer response
health. The shared UI and routing retain the same adapter authority, and explicit
model discovery is preserved. [Validation](../validation/background-health.md)
passes **61 app groups per engine**, **23 provider transport checks per engine**,
**11 settings checks per engine**, **190 unit tests** and `npm run check`.
The [aggregate record](../validation/results/background-health-checks-macos.json)
verifies 100 unchanged app source hashes, 13 additional auxiliary source hashes
and 12 artifacts. Exact canonical/sync records and content dispatches remain
unchanged through the new browser scenario. Completed plans remain **7 of 23**;
real-provider health/content/scale qualification remains open.

Previous completed iteration (2026-09-10): **pending-change recovery through
navigation and search** (plans 08/23). Unknown outcomes now have a separate,
origin-scoped recovery region that survives ordinary-error dismissal, opening
another conversation and lexical search. Checks replay the frozen original
batch, share one in-flight task and preserve newer navigation and errors.
A refused check stays recoverable; an acknowledged write is not made unknown
again by a subsequent read failure. The [validation](../validation/pending-recovery.md)
passes **60 groups per browser engine**, **127 unit tests** and `npm run check`.
The [aggregate record](../validation/results/pending-recovery-checks-macos.json)
verifies **95 unchanged source hashes** and 10 retained artifacts. The actual
lost-reply proof preserves exact canonical/sync records, provider traffic and
newer keyboard focus. Completed plans remain **7 of 23**; broader recovery,
assistive-technology and release gates remain open.

Previous completed iteration (2026-09-10): **action context, recovery focus and
compatibility announcements** (plans 08/13). Message actions include speaker and
page-position context; conversation fallback removal names its target. Long-name
alias application fits 320px/enlarged layouts. One persistent compatibility
status announces settled semantic outcomes without repeated alert remounts;
settings changes still invalidate consent. Workspace recovery preserves visible
focus and yields to user movement; pending unknown outcomes cannot be dismissed,
while known refusals can. Integrated checks fixed routing-hook lifetime and a
recovery-heading layout collapse affecting navigation.
[Validation](../validation/action-accessibility.md) passes **59 groups per engine**,
**97 unit tests** and `npm run check`. The [aggregate record](../validation/results/action-accessibility-checks-macos.json)
verifies **93 browser source hashes**, the additional controller test source and
31 retained artifacts. Completed plans remain **7 of 23**. Pending recovery through
navigation/search and actual assistive-technology qualification remain open.

Previous completed iteration (2026-09-10): **branch, compaction and routing-alias
accessibility** (plans 08/13). Stable headings preserve keyboard position after
review closure, alias/fallback removal and stale fresh-branch consent; user focus
movement and deliberate blur take precedence. Summary labels match visible text,
count completion has an atomic status, and active input boundaries exceed the
measured 3:1 threshold. Five editor/review layouts fit 320px at normal and enlarged
text in both engines; WebKit's closed native-select overflow is corrected.
[Validation](../validation/review-accessibility.md) passes **54 groups per engine**,
**43 controller tests** and `npm run check`. The [aggregate record](../validation/results/review-accessibility-checks-macos.json)
verifies **90 source hashes** and retains 62 artifacts. One earlier run's provider
transport interruption did not recur in the final complete run; its failed report
is retained without a transport-fix claim. Completed plans remain **7 of 23**;
actual screen-reader and broader accessibility acceptance stay open.

Previous completed iteration (2026-09-10): **async panel focus and bounded progress
announcements** (plans 08/13). Preferences, providers, import, export and restore
retain keyboard position through disabled or removed controls; explicit blur,
Tab-away and pointer movement cancel recovery. Import navigation focuses the
loaded conversation. Progress live regions contain phase names, with numeric
counters separately readable. Browser verification exposed and fixed ignored
export preparation during initialization, and controller regressions cover
admission, cancellation and disposal before dispatch. [Validation](../validation/keyboard-focus.md)
passes **51 groups per engine**, **51 controller tests** and `npm run check`.
The [aggregate record](../validation/results/keyboard-focus-checks-macos.json)
verifies **88 source hashes**, retained logs, controlled window-return diagnostics
and enlarged-text screenshots. Completed plan count remains **7 of 23**;
[remaining accessibility findings](../validation/accessibility-open-findings.md)
keep plans 08/13 open.

Previous completed iteration (2026-09-10): **persisted interaction preferences**
(plans 08/13). Message timestamps, model badges, comfortable/compact composer
layout and dropdown/list model selection now join the persisted send key.
Version-1 rows normalize with compatible defaults without writes; explicit edits
use the version-2 closed row, preserve sibling settings and reject stale revisions.
[Validation](../validation/interaction-preferences.md) passes 65 core, 57 canonical,
13 archive and 12 preference/alias tests; the shared application passes 46 groups
per engine, including lost-reply recovery, cross-client conflict, unchanged
drafts/history and narrow process restart. `npm run check` passes, and the
[aggregate record](../validation/results/interaction-preferences-checks-macos.json)
verifies 84 source hashes. Plan 08's composer task and plan 13's interaction-settings
task are now checked. Completed plan count remains **7 of 23**; accessibility,
onboarding and themes remain open.

Previous completed iteration (2026-09-10): **bounded automatic library refresh**
(plan 08). Storage notifications now coalesce into one dirty flag; automatic
refresh waits for active view loads to settle before scheduling a follow-up.
Explicit navigation remains immediate, stale successes/errors cannot overwrite
it, and failed parallel message groups hold the refresh slot until their sibling
reads finish. Disposal and changed archive selection prevent later automatic
work. [Nine controller tests pass](../validation/library-refresh.md); seven fail
against an isolated copy of the prior implementation. Summary/branch tests
(31), switching workflows (74), both application browser engines (44 each) and
`npm run check` pass, with [current source hashes and retained logs](../validation/results/library-refresh-checks-macos.json).
The reproduced refresh defect is closed. Completed plan count remains **7 of 23**;
plan 08 still needs its accessibility audit.

Previous completed iteration (2026-09-10): **verified PDF attachments through the shared
composer** are implemented ([ADR 0027](../decisions/0027-composer-file-inputs.md),
[provider review](../validation/provider-file-contracts.md)). Original bytes are
staged, previewed as metadata, published as File/Attachment records and reloaded
for inspection/count/send/regeneration. Missing and unsupported files are refused
without implicit text conversion. Regional catalogs are constrained to their
reviewed modalities; compatibility reports refresh when eligibility replaces an
adapter under unchanged connection/model identifiers. Cancellation releases host
handles and worker stages, including late receipts. Provider units (51),
attachment units (28), switching/workflow units (74), settings units (16),
OAuth units (12), host browser checks (30) and provider browser checks (23 per
engine) pass. `npm run check` passes after the restore navigation correction.
The corrected focused WebKit run and final Chromium/WebKit application run
pass all 44 groups per engine, including portable restore/regeneration and
credential-free process restart. The [aggregate validation](../validation/results/composer-files-checks-macos.json)
checks 86 source hashes against the final worktree. [Composer-file validation](../validation/composer-files.md)
records the final evidence and preserved failed attempts. The failure was a
click on the old library during asynchronous archive replacement: its view read
was rejected before the new library mounted. Navigation and creation now disable
during that transition; assertions and timeouts are unchanged. Keep all plan
counts unchanged.

Previous completed iteration (2026-09-10): **browser OAuth under production
COOP/COEP** is implemented and qualified in Chromium and Playwright WebKit
([validation](../validation/browser-oauth.md), [ADR 0026](../decisions/0026-browser-oauth-callbacks.md)).
The original host owns random state/verifier, exact issuer/redirect admission,
PKCE S256, bounded CORS exchange and an opaque session credential. A dedicated
built callback returns the authorization response over a transaction-specific
BroadcastChannel, clears its URL and preserves isolation. Popup navigation
explicitly suppresses referrers without relying on extra main-page headers.
Both production OAuth registries remain empty; no live provider login is enabled.

This also fixes an existing manual credential-replacement race and fences
late OAuth/relay credentials and transfer admission across pagehide. A restored
cached document must wait for cleanup before reconnecting; cleanup failure leaves
its host unavailable. Ordinary unloading still disposes the session permanently.
The shipped nginx callback route applies isolation/referrer/cache/CSP policy and
omits callback request logs; upstream proxies still need their own qualification.

**12 unit groups**, **44 OAuth browser groups (22 per engine)**, **30 existing
host tests**, **10 regional host unit tests**, **42 shared-app regression groups
per engine**, **11 actual nginx checks** and `npm run check` pass. The reports
retain matching source and artifact hashes. Every engine observed 24 authorization
navigations, 14 token requests and 8 authenticated resource requests; those are
synthetic loopback HTTP observations, not a real provider or public TLS deployment.
Actual back/forward-cache restoration was not observed: both history tests
reloaded, so reset/cleanup races have controlled unit evidence only.

An initial existing-host run timed out in the WebKit 32 MiB download test. Its
unchanged focused rerun and final full suite pass; the initial cause is unproven
and retained in validation. The earlier native regional stalls are likewise not
claimed fixed by this work. Investigate request/reply or download progress if
these failures recur; do not extend timeouts or erase the failed evidence.

Completed plan count stays **7 of 23**. Plan 05 still needs other native callback
platforms, real provider registrations and the scheduled OS/release integrations.
The preceding [native OAuth slice](../validation/native-oauth.md) qualifies installed
macOS callback delivery with a synthetic opener observer; actual native external
browser authorization UX remains open. [Blob inventory](../validation/blob-inventory.md)
closed plan 03; broader diagnostics and reviewed repair remain plan 23 work.
Historical reports retain their original hashes and measured scope.

Plan 10's routing task remains closed by the [native regional proof](../validation/native-regional-attempts.md)
and combined web/relay/persistence matrix. **Zero actual model runs** have been
scored for summary fidelity; task 5 stays open. Authored fixtures and synthetic
responses cannot establish factual preservation or instruction resistance.
Qualification needs recorded model requests/outputs, fact and unsupported-claim
grading, repeated compaction and downstream questions on an authorized
redistributable local model or provider run without spending or private data.
Plan 04's official-export qualification also remains open for authorized captures.

Previous completed iteration (2026-09-11): **provider reasoning continuation and
manual thinking** (plan 06, [ADR 0032](../decisions/0032-reasoning-continuation.md)).
The reviewed Haiku 4.5 entry declares its manual-thinking profile; the composer's
thinking budget refuses every documented constraint with the reason; receipts are
verified through the storage boundary and bound to generation, response, kinds,
indexes and stream records, or reconstructed from retained raw segments within
8 MiB; verified blocks travel first and unchanged to the producing model only,
and other targets receive a named omission the contract permits outside tool
use. [Validation](../validation/reasoning-continuation.md) passes **94 provider
tests**, **85 switching tests**, **29 provider browser checks per engine**,
**65 application groups per engine**, **19 native checks**
and `npm run check`. Completed plan count remains **7 of 23**; plan 06 still
needs provider-specific unsupported parts, live-provider qualification and
checkpoint scale.

Previous completed iteration (2026-09-11): **provider-specific output parts**
(plan 06, [ADR 0033](../decisions/0033-provider-output-parts.md)). Citations
travel as plain source notes, structured output as JSON text, refusal markers
and the generation's own raw-only artifacts are omitted with a counted
transformation named in the switch report and portability, and import-derived
artifacts stay refused by name, so a cited turn can now continue on any target.
[Validation](../validation/provider-output-parts.md) passes **95 provider
tests**, **89 switching tests**, **66 application groups per
engine**, **29 provider browser checks per engine** and
`npm run check`. Completed plan count remains **7 of 23**; plan 06's content
profiles are complete, and it still needs live-provider qualification and
checkpoint batching at scale.

Next concrete slice: **plan 22 storage implementation**: the int8
projection (`int8-global-symmetric-v1`) as a derived sqlite-vec `int8[384]`
table with scale/generation metadata and a rebuild path, `candidates()`
switching to coarse→float32 rerank above a size threshold, refusal on
representation mismatch, and Node/browser proofs that filters, RRF, deletion
and rebuild keep the ADR 0034 guarantees; then measure sqlite-vec int8 KNN in
Chromium and WebKit at 100k+ vectors. Then plan 12 (compare, critique, bulk
migration), whose prerequisites (08, 10) are in place. Plan 13's themes and accessibility audit, plan 11's real
chatgpt.com run and desktop pairing remain open; do not contact real providers. Live provider behavior and summary fidelity remain separate authorized
gates; do not spend on requests. The compiled model stays a provisioned build
input (`packages/quixi-embed/build/arctic-xs.qxmodel`).

Plan 07's resumable initial verification is now qualified in the byte/catalog
and production-client browser proofs. Release-corpus relevance, disk/latency
scale, portability filtering and semantic integration remain separate open gates.

Actual screen-reader output, wider keyboard/host/state coverage, themes and
onboarding remain separate open acceptance requirements.

The earlier-numbered outstanding gates need their specified prerequisites:
plan 01 actual Safari/WebKitGTK qualification; plan 04 authorized official exports;
plan 05 real public-client registrations/CORS, other native host delivery and OS
integrations scheduled with their consuming features. Plan 10 still needs actual
summary-quality runs. Keep progressing independently actionable work. No spending,
private transmission, deployment, publication or commit is authorized.

The contract corrections replace materialized deletion closures and
message-part ID lists with bounded scopes/paging, and preserve large text through
verified blob references. Plan 02 records the updated pure-contract acceptance
evidence; plan 03 implements bounded staging and atomic complete-thread publication.

Plan 14 is complete: the [multi-isolate forced-GC captures](../../perf/documents/GC.md#multi-isolate-and-thousand-page-captures) keep every isolate's post-collection heap in the low megabytes across dense 100-page and real 1,000-page documents in Chromium, closing its memory criterion; WebKit heaps, native memory and release scale remain plan 24 work. The earlier document notes follow. The
[ordinary browser replay](../../perf/documents/STORAGE.md) passes eight dense and
two near-cap image cases after reducing repeated page-credit validation and reusing
exact canonical staging serialization. Repository and browser/native correctness
checks pass; the [OPFS SQL diagnostic](../../perf/documents/sql/README.md)
identifies substantial durable commit costs without attributing lock/lifecycle
residual time to serialization. [Eight dense workload captures](../../perf/documents/DENSE.md)
pass across Chromium/WebKit through 15.1 million extracted UTF-16 units. Their
parser growth led to per-page shared-cache cleanup: the [paired diagnostic](../../perf/documents/GC.md)
reduces 100-page post-GC parser heap from 109.29 to 3.17 MiB. Broader memory
acceptance remains open. Reviewed extraction clearing and explicit
re-extraction now pass sixteen document UI groups per browser engine, preserving
original bytes and rejecting stale results. Failed-PDF reasons survive restart;
explicit retry/clear and capacity rejection close the recoverable-outcome criterion.
Exact uncertain-operation and producer
exclusion tests cover the helper/controller boundaries. The
[performance baseline](../../perf/documents/README.md) exposed a near-cap image PDF
range rejection and repeated global scans during page indexing; all ten post-fix
browser cases pass, with recorded load/memory limits and smaller-case regressions.
Low-text and unsupported-layout notices survive page reads and restart. Column,
table and code normalization preserves exact original source spans. The
[native proof](../../tests/hosts/document-proof/README.md) passes actual macOS
workers/CSP/fonts and layout metadata across restart; compatible extraction-schema
upgrades preserve old pages and receipts. The shared UI imports PDFs, shows extraction
progress, stops/resumes work and opens exact page references from search results.
See the [document UI evidence](../../packages/app/src/features/documents/tests/browser/README.md). Real PDF.js → durable
pages → shared FTS passes Chromium/WebKit with early page-one search, cancellation,
resume, concurrent chat and browser restart. See the [PDF persistence evidence](../../packages/documents/tests/persistence-browser/README.md).
Managed startup, mandatory worker selection fences, schemas 9/10, the single-use
reviewed activation callback and read-only retained-history access are implemented.
The [production activation evidence](../../packages/storage/tests/selection/integration/README.md)
and [retained reader evidence](../../packages/storage/tests/retained/README.md)
cover real browser recovery, including schema-8 rescue and portable archives
upgraded in the isolated candidate; full platform/scale qualification remains
outstanding.
The [frozen schema-8 worker proof](../../packages/storage/tests/selection/schema8/README.md)
passes seven checks per browser: known old writers reject a committed future
schema, while rolled-back/interrupted upgrades still permit them. Protocol 2
also rejects old followers that could otherwise forward calls without opening SQLite.
[ADR 0012](../decisions/0012-archive-selection.md) lists every foreground,
maintenance and constructor write that needs fencing. The [page repository](../../packages/storage/src/worker/extraction/README.md)
is integrated with canonical document identity and shared chunks; its parser-memory
qualification gates remain open. Use verified original-source tokenizer offsets when
implementing semantic chunk cuts. Schema-8 live upgrades and schema-8 archive restores are tested; schema 7 and
earlier are refused by name, and full cross-host/scale qualification remains open.

## How to use the plans

- Follow the explicit prerequisites. Numbers are stable identifiers and a reading
  order; they do not force independent workstreams into a serial schedule.
- Each plan defines its outcome, product-section references, task checklist,
  deliverables/interfaces, acceptance criteria, and boundaries.
- Before beginning a plan, inspect the current code and predecessor deliverables.
  Update its status and record concrete decisions as they are made. On completion,
  link the implementation and validation evidence and mark the criteria satisfied.
- Treat product.md as the source of requirements and architecture.md as the source
  of package ownership. Resolve a conflict explicitly instead of quietly changing
  a plan into a new product specification.
- Where the spec requires research or benchmark selection, the task is to produce
  a recorded decision and evidence before dependent implementation. These plans
  do not invent checkpoint hashes, quality thresholds, performance guarantees,
  provider extraction support, or a Cloud recovery scheme.
- Keep unit tests with their package, cross-package scenarios in tests/, product
  workloads in perf/, and inference-specific goldens/benchmarks with QuixiEmbed.
  Use synthetic or redistributable fixtures rather than private user history.
- Early storage/import/export work can use development harnesses in the shared
  scaffold. Complete product UI wiring follows the framework selection in 08;
  this keeps the first real importer from waiting for the full chat interface.

## Plan index

| Plan | Workstream | Prerequisites |
| --- | --- | --- |
| [01 — Prove universal local storage](./01_prove_universal_storage.md) | A1 — platform gate | None |
| [02 — Define canonical history and shared contracts](./02_define_canonical_history.md) | A2 — canonical model | [01](./01_prove_universal_storage.md) |
| [03 — Build canonical storage repositories and blobs](./03_build_storage_repositories.md) | A2 — durable product storage | [01](./01_prove_universal_storage.md), [02](./02_define_canonical_history.md) |
| [04 — Import provider exports with provenance](./04_import_provider_exports.md) | B1/B3 — historical import | [02](./02_define_canonical_history.md), [03](./03_build_storage_repositories.md) |
| [05 — Implement host capabilities and provider relay](./05_implement_host_capabilities_and_relay.md) | A3 — host infrastructure | [02](./02_define_canonical_history.md) |
| [06 — Integrate the first live providers](./06_integrate_live_providers.md) | A3 — provider adapters | [02](./02_define_canonical_history.md), [05](./05_implement_host_capabilities_and_relay.md) |
| [07 — Build shared chunks and lexical search](./07_build_shared_chunks_and_fts.md) | A5/D2 foundation — always-available search | [02](./02_define_canonical_history.md), [03](./03_build_storage_repositories.md) |
| [08 — Build the shared chat and library experience](./08_build_chat_and_library_ui.md) | A4 — first daily-use interface | [03](./03_build_storage_repositories.md), [05](./05_implement_host_capabilities_and_relay.md), [06](./06_integrate_live_providers.md), [07](./07_build_shared_chunks_and_fts.md) |
| [09 — Add portable archives and open export](./09_add_archives_and_open_export.md) | A7 — ownership and recovery | [03](./03_build_storage_repositories.md) |
| [10 — Add routing and cross-provider continuation](./10_add_routing_and_provider_switching.md) | A6 — portability and switching | [06](./06_integrate_live_providers.md), [08](./08_build_chat_and_library_ui.md) |
| [11 — Build browser-extension history import](./11_build_browser_extension_import.md) | B2/B3 — extraction and incremental transfer | [04](./04_import_provider_exports.md), [05](./05_implement_host_capabilities_and_relay.md) |
| [12 — Add compare, critique, and bulk migration](./12_add_compare_critique_and_bulk_migration.md) | Product workflows — multiple generations and portability | [08](./08_build_chat_and_library_ui.md), [10](./10_add_routing_and_provider_switching.md) |
| [13 — Complete onboarding, appearance, and accessibility](./13_complete_onboarding_appearance_and_accessibility.md) | Shared product experience | [04](./04_import_provider_exports.md), [08](./08_build_chat_and_library_ui.md), [09](./09_add_archives_and_open_export.md), [10](./10_add_routing_and_provider_switching.md), [11](./11_build_browser_extension_import.md) |
| [14 — Extract and search document text](./14_extract_and_search_documents.md) | D1/D2 — bounded document processing | [03](./03_build_storage_repositories.md), [07](./07_build_shared_chunks_and_fts.md) |
| [15 — Add optional local OCR](./15_add_optional_local_ocr.md) | Deferred OCR | [14](./14_extract_and_search_documents.md) |
| [16 — Freeze the embedding port and retrieval benchmark](./16_freeze_embedding_port_and_retrieval_benchmarks.md) | C0 — independent inference foundation | None |
| [17 — Build the scalar encoder and model compiler](./17_build_scalar_encoder_and_model_compiler.md) | C1/C4 — correctness and packaging | [16](./16_freeze_embedding_port_and_retrieval_benchmarks.md) |
| [18 — Optimize the WASM SIMD backend](./18_optimize_wasm_simd.md) | C2 — universal semantic fallback | [17](./17_build_scalar_encoder_and_model_compiler.md) |
| [19 — Build and optimize the WebGPU backend](./19_build_webgpu_backend.md) | C3 — optional accelerated inference | [17](./17_build_scalar_encoder_and_model_compiler.md) |
| [20 — Schedule bounded embedding work](./20_schedule_embedding_work.md) | C5 — interactive inference service | [17](./17_build_scalar_encoder_and_model_compiler.md) |
| [21 — Integrate semantic indexing and hybrid search](./21_integrate_semantic_and_hybrid_search.md) | C6/D3 — optional product integration | [07](./07_build_shared_chunks_and_fts.md), [14](./14_extract_and_search_documents.md), [18](./18_optimize_wasm_simd.md), [20](./20_schedule_embedding_work.md) |
| [22 — Benchmark and implement compressed vector retrieval](./22_benchmark_compressed_vector_retrieval.md) | C7 — large-index semantic retrieval | [16](./16_freeze_embedding_port_and_retrieval_benchmarks.md), [21](./21_integrate_semantic_and_hybrid_search.md) |
| [23 — Build diagnostics and archive recovery tools](./23_build_diagnostics_and_recovery.md) | Product reliability — Quixi Doctor | [03](./03_build_storage_repositories.md), [09](./09_add_archives_and_open_export.md) |
| [24 — Validate scale and release supported hosts](./24_validate_scale_and_release_hosts.md) | Release gates — core, migration, and semantic milestones | [01](./01_prove_universal_storage.md); feature gates below |
| [25 — Design Cloud encryption, synchronization, and recovery](./25_design_cloud_encryption_and_recovery.md) | Deferred Cloud — design gate | [02](./02_define_canonical_history.md), [03](./03_build_storage_repositories.md), [09](./09_add_archives_and_open_export.md) |
| [26 — Implement optional encrypted Cloud sync and backup](./26_implement_optional_cloud_sync.md) | Deferred Cloud — implementation after design gate | [24](./24_validate_scale_and_release_hosts.md), [25](./25_design_cloud_encryption_and_recovery.md) |

## Workstreams and parallel work

The sequencing follows [102. Development structure](../product.md#102-development-structure) and the implementation tracks in
[103. Track A — Product Core](../product.md#103-track-a--product-core), [104. Track B — Historical Import](../product.md#104-track-b--historical-import), [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed), [106. Track D — Documents](../product.md#106-track-d--documents).

- **Start now:** 01 (universal storage proof) and 16 (embedding contract and
  retrieval benchmark) are independent. Research and fixtures for later work can
  be prepared early, but dependent interfaces must use their completed contracts.
- **Product/storage:** 01 → 02 → 03. Host research can start after 01; host adapter
  implementation (05) follows the contracts in 02. Providers (06) require those
  canonical and host contracts. Imports (04), search
  (07), and archives (09) can proceed independently after their storage foundation.
- **Product UI:** 08 composes the initial product. Routing (10), extension import
  (11), comparison/migration (12), and onboarding/appearance (13) follow their
  listed prerequisites. Accessibility begins in 08, not only in the final audit.
- **Documents:** 14 follows storage/shared chunking and does not depend on an
  encoder. Optional OCR (15) extends this path later.
- **Inference:** 16 → 17, then SIMD (18), WebGPU (19), and scheduling (20) can
  progress independently. Integration (21) requires the SIMD fallback; WebGPU
  is added when ready. Compressed retrieval (22) follows a working baseline.
- **Reliability:** 23 starts with storage and archives and gains inference checks
  as that runtime appears. Release validation (24) runs at each milestone, using
  the conditional gates below instead of waiting for every plan.
- **Cloud:** 25 is a deferred design gate. Implementation (26) follows that reviewed
  design and a validated local-first release. Cloud never gates local usability.

## Milestone gates

| Milestone | Required completed work | Product criteria |
| --- | --- | --- |
| First usable build | [01](./01_prove_universal_storage.md), [02](./02_define_canonical_history.md), [03](./03_build_storage_repositories.md), [05](./05_implement_host_capabilities_and_relay.md), [06](./06_integrate_live_providers.md), [07](./07_build_shared_chunks_and_fts.md), [08](./08_build_chat_and_library_ui.md), [09](./09_add_archives_and_open_export.md); validate through 24 | [107. First usable build](../product.md#107-first-usable-build) |
| Compelling migration build | First usable build plus [04](./04_import_provider_exports.md), [10](./10_add_routing_and_provider_switching.md), [11](./11_build_browser_extension_import.md); validate through 24 | [108. First compelling migration build](../product.md#108-first-compelling-migration-build) |
| Complete local product | Migration build plus [12](./12_add_compare_critique_and_bulk_migration.md), [13](./13_complete_onboarding_appearance_and_accessibility.md), [14](./14_extract_and_search_documents.md), [23](./23_build_diagnostics_and_recovery.md); validate through 24 | Local capabilities in [115. V1 success criteria](../product.md#115-v1-success-criteria) and all of [116. Product-core success criteria](../product.md#116-product-core-success-criteria) |
| Semantic-search build | Required local history/search/document paths plus [16](./16_freeze_embedding_port_and_retrieval_benchmarks.md), [17](./17_build_scalar_encoder_and_model_compiler.md), [18](./18_optimize_wasm_simd.md), [19](./19_build_webgpu_backend.md), [20](./20_schedule_embedding_work.md), [21](./21_integrate_semantic_and_hybrid_search.md), [22](./22_benchmark_compressed_vector_retrieval.md); validate through 24 | [109. Semantic-search build](../product.md#109-semantic-search-build), [112. Semantic-search stress tests](../product.md#112-semantic-search-stress-tests), [113. QuixiEmbed benchmarks](../product.md#113-quixiembed-benchmarks), [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria) |
| Optional OCR | [14](./14_extract_and_search_documents.md), [15](./15_add_optional_local_ocr.md) with document validation | [90. Scanned PDFs](../product.md#90-scanned-pdfs) |
| Optional Cloud | Validated local release plus [25](./25_design_cloud_encryption_and_recovery.md), [26](./26_implement_optional_cloud_sync.md) | [95. Quixi Cloud](../product.md#95-quixi-cloud), [96. Synchronization operations](../product.md#96-synchronization-operations), [97. Derived data and sync](../product.md#97-derived-data-and-sync), [110. Release/platform risks](../product.md#110-releaseplatform-risks) |

The complete local product must pass with semantics disabled. The semantic build
must exercise both WebGPU and WASM SIMD and the chosen compressed retrieval path.
OCR and Cloud remain optional. A failed storage gate prevents support claims for
that host; a failed semantic-performance gate does not invalidate a usable core.

## Requirements coverage and guardrails

Every plan links directly to relevant numbered sections of product.md. The index
also carries the governing product and architecture requirements:

- [1. Product](../product.md#1-product)
- [2. Product positioning](../product.md#2-product-positioning)
- [3. Product pillars](../product.md#3-product-pillars)
- [4. V1 semantic scope: text only](../product.md#4-v1-semantic-scope-text-only)
- [5. Hard architectural rules](../product.md#5-hard-architectural-rules)
- [7. Runtime architecture](../product.md#7-runtime-architecture)
- [8. Host architecture](../product.md#8-host-architecture)
- [102. Development structure](../product.md#102-development-structure)
- [118. Explicit v1 non-goals](../product.md#118-explicit-v1-non-goals)
- [119. Product differentiation](../product.md#119-product-differentiation)
- [120. Final architecture](../product.md#120-final-architecture)

Preserve these rules throughout the roadmap: one Storage Worker/SQLite WASM/OPFS
backend, authoritative canonical history, derived/rebuildable search data,
provider-neutral continuation, shared chat/document chunks, bounded bulk work,
optional inference, and explicit Cloud opt-in. V1 does not gain image embeddings,
native mobile apps, autonomous agents, or other non-goals through these plans.

Platform and provider review gates are work to perform, not assumed approvals.
The Cloud design plan explicitly resolves the recovery questions left open by
the spec before its implementation plan can begin.
