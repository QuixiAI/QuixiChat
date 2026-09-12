# Shared application acceptance

The ordinary web and desktop entry points now mount the same React library,
conversation, imports, exports and provider-settings interface. The application injects
StorageClient and HostClient; only the elected Storage Worker opens SQLite.
The developer storage proof remains at `/storage-proof`.

The [semantic search qualification](semantic-search.md) appends a fresh-archive
scenario with the real pinned embedding model to the full runner (plan 21):
enrolment, backend selection, Semantic and Best ranking with origin
explanations, pause/resume, restart from the OPFS model copy, disable/delete
and explicit unavailability, ten checks per engine. The production storage
worker now chunks with the frozen tokenizer, so every earlier group reruns
against that policy.

The [provider output-parts qualification](provider-output-parts.md) extends the
full runner to 66 groups per engine: citations, unknown output blocks and
provider-specific delta fields from either provider are retained and shown, and
every later request carries the answer with a plain source note and none of
the provider-specific records, with each transformation named.

The [reasoning-continuation qualification](reasoning-continuation.md) extends
the full runner to 65 groups per engine: manual thinking for the reviewed Haiku
4.5 profile with every documented constraint refused in the composer, receipts
recorded beside their markers, signed and redacted blocks carried first and
unchanged through count, send, regeneration and a fresh browser process on the
producing model, and a named omission on any other target. The seeded
portability thread's unverified marker is now portable with that omission named
per target instead of blocked.

The [thinking-block capture regression](reasoning-block-capture.md) passes all
63 groups per engine against the updated normalizer and generation consumer.
Its separate provider proofs verify exact signed/redacted receipts, lost replies,
restart and isolated portable restore.

The [audio-input qualification](provider-audio-input.md) extends the full runner
to 63 groups per engine with 115 unchanged application source hashes. WAV and
MP3 originals survive picker/drop, provider dispatch, regeneration, portable
restore and browser restart. Unsupported routes refuse audio explicitly.
Browser/native provider transport is qualified separately against the same source set.

The [incremental blob-verification regression](incremental-search-verification.md)
passes all 61 groups per engine with 107 unchanged application source hashes.
Its specialized storage proofs establish bounded indexing verification, reads
between incomplete admissions and canonical-safe restart; this full app rerun
qualifies the integrated behavior against those byte/catalog/search changes.

The [background account-health proof](background-health.md) extends the complete
runner to 61 groups per engine with 100 unchanged source hashes. Automatic
metadata checks recover after controlled outages, respect offline/hidden states,
pause after rejected credentials and cancel held HTTP work without changing
canonical records or sending conversation content. Provider transport and
standalone settings proofs also pass against the same implementation.

The [pending-recovery proof](pending-recovery.md) extends the complete runner to
60 groups per engine with 95 unchanged source hashes. It retains origin-scoped
reconciliation through error dismissal, thread navigation and lexical search,
including a refused check and a held exact retry that preserves newer focus and
selection without additional canonical writes or provider traffic.

The [action-context and workspace-recovery proof](action-accessibility.md)
extends the complete runner to 59 groups per engine. It qualifies contextual
message/fallback names, long-name alias application, stable compatibility
announcements and global recovery focus, with 93 unchanged browser source hashes.
The navigation/search gap identified by that run is resolved by the later
pending-recovery proof above.

The [branch and alias review accessibility proof](review-accessibility.md)
extends the complete runner to 54 groups per engine, with stable review focus,
summary labels/count status, and measured 320px/enlarged-text layout and authored
border contrast. Its final report verifies 90 unchanged source hashes. Actual
screen-reader and wider host/state qualification remain open.

The [async-panel keyboard and focus proof](keyboard-focus.md) extends this runner
with preference/provider/import/export/restore focus, user-movement precedence,
phase-only progress announcements and representative enlarged-text checks.
Its retained report identifies the exact qualified source snapshot and remaining
accessibility gates.

The preceding [attachment exclusion acceptance](context-compaction.md) adds reviewed,
cancellable per-occurrence exclusions with immutable snapshots/events, shared
count/send/regenerate markers, unchanged originals and restart persistence.

The preceding [summary acceptance](context-summaries.md) adds generated proposals,
verified frozen inputs, explicit review/edit/apply/clear, isolated attempts and
usage, shared prefix-aware requests, cancellation and unknown-outcome recovery.
The combined browser proof also carries attachment exclusions through a failed
primary and fallback and expires prompt counts when their request scope changes.

The preceding [fresh-branch acceptance](context-branches.md) adds explicit review,
atomic empty selection and audit events, retained draft and original history,
matching count/primary/fallback requests, pending replay and offline restart.

The preceding [cost-limit acceptance](request-cost-limits.md) adds independent input
and total per-attempt limits, conservative budgets without automatic counting,
exact-request count binding, pre-write guards for sends and summaries, fallback
budget checks, version-4 alias snapshots and restart inspection.

The preceding [provider-capability review](provider-capability-review.md) corrects
counting availability to describe the implemented connection, and reruns every
application check.

The preceding [native regional connection slice](native-regional-connections.md)
adds credential-bound regional setup. The latest [processing-region policy
slice](processing-region-policies.md) adds version-5 requirements and independent
count/generation/fallback/summary guards, with policy and alias persistence.
The latest [regional relay validation](regional-web-relays.md) adds a separate
real-relay app proof and reruns the main regression; integrated native constrained
attempt qualification remains open.

## Recorded checks

Since 2026-09-12 the proof records 98 checks per engine. The newest two are
[compare mode](compare.md) of plan 12; before them the
[bulk portability analysis](bulk-portability.md) of plan 12; before it, the
[accessibility audit](accessibility-audit.md) across ten views. The two before it
assert the empty states added by the [presentation review](presentation-review.md):
a search with no matches and a conversation with no messages. Before them: a
160-character conversation title with a 70-character unbroken token wraps
in the library, the heading and the settings form at 320px and 200% root
text without overflow, and renaming back restores the original. Before it,
the six-theme scenario of [ADR 0039](../decisions/0039-appearance-themes.md)
(see [interaction-preferences.md](interaction-preferences.md#themes--2026-09-12-adr-0039)). The two before it: a
streamed two-part reply changes the polite generation status exactly twice
(in progress, complete), observed with a MutationObserver on the status
region, so committed chunks never re-announce; and the conversation library
and an open conversation with saved messages fit 320px at normal and 200%
root text size without horizontal overflow (measured with the review layout
capture; screenshots and JSON under `test-results/review-accessibility-*`).

Run `npm run test:app:browser`. The
[retained report](results/regional-relay-regression-macos.json) records source hashes and
forty-two checks in each of actual Chromium and Playwright WebKit on macOS 26.6.2.
It replaces the earlier fourteen-check report from the same day, which was not retained.
It builds the real shared app and production worker, using controlled loopback
HTTP through the production host and provider adapters. It does not call a paid
provider or establish installed Safari, Tauri or other operating-system support.

The checks cover create/rename/tags/system prompt, committed text visible before
an explicitly held HTTP terminal event, a second turn with the selected ancestor
path, distinct regenerate attempts, immutable edited branches, continuation
through the second adapter, stopped HTTP with retained output, automatic lexical
indexing/search across stream events, exact long Unicode output in bounded text
segments, and a fresh browser process reopening the same OPFS archive. They also
download portable and open exports, verify their TAR entries, explicitly remove
retained browser download files, and resume a ready export after process restart
without rebuilding its output.
Output-limit checks reject empty, fractional and out-of-range values before a
message or HTTP request is created, including keyboard submission. Distinct
attempts preserve their exact provider request settings for both adapters.
Temperature, top-p and stop-sequence fields appear because the reviewed catalog
declares them. Out-of-range temperature or top-p, a fifth stop sequence or an
over-long one disables sending; keyboard submission then creates no message or
request and the draft survives. Valid settings reach the OpenAI body as
`temperature`, `top_p` and `stop` and the Anthropic body as `temperature` and
`stop_sequences`; blank fields are omitted, and each attempt records the exact
values it sent. Switching to the Anthropic model re-bounds temperature to 0–1
and blocks a value that was valid for OpenAI until it is corrected.
A user message carrying a verified PNG attachment, staged through the
production blob path, is regenerated with the Anthropic adapter: the request
body's user content becomes a text block followed by a base64 image block whose
data equals the seeded bytes, the attempt completes, and its recorded
parameters carry no image data. The composer cannot yet attach files itself;
this proves the storage-to-provider image path on existing attachments.
The composer then attaches images itself: a synthetic PNG chosen through the
host file picker and another dropped onto the composer are streamed through the
host into verified staged blobs and previewed; a text file, a file over the
2.5 MiB request bound and GIF bytes declared as PNG are refused with a visible
notice and no staged image; the chosen image is removed before sending; and
the message publishes only the dropped image as an available attachment with
the exact SHA-256 and an Image part, sends it as the provider image block for
the active adapter, and previews it again from archived bytes at its original
dimensions. The removed image never reaches history or the request.
Provider answers drive the composer's connection status. The loopback
provider answers one request with 429 and a retry-after header: the attempt is
recorded as failed, the composer shows the connection as rate limited with the
provider's reason and a retry countdown, sending is refused until the retry
time passes, and then reopens by the clock. A 401 answer shows authentication
expired, refuses sending, and offers Providers, where the same health and
reason appear from the last chat response; checking the connection there
returns it to healthy and sending reopens. Setting the device's own offline
signal shows Offline and refuses sending until the device is back online. Health
is the single record of the connection's adapter, so checks and chat responses
update the same status. This check exposed and fixed a defect: a failed attempt
leaves an assistant message with no content on the branch, and the next
request in that branch was refused by the adapter as an empty turn; the request
now omits assistant turns without content while history keeps the attempt.
Token and cost displays follow reported usage. The loopback providers report
12 input and 20 output tokens with zero cached tokens; every completed attempt
records that usage and an estimate from the reviewed catalog price (0.000112
USD for Claude Haiku 4.5, 0.0000368 USD for GPT-4.1 mini), a stopped attempt
keeps the input-only estimate its reported usage already established, and
failed attempts stay unpriced. Each attempt line shows its tokens and the estimate
labelled as coming from reviewed pricing, or unknown, and the conversation
header shows attempts, token sums and the summed estimate with the number of
priced and unpriced attempts, aggregated by the storage worker in SQL rather
than from the loaded window.
Counting prompt tokens is an explicit composer action. With the Anthropic
connection selected, it sends the exact draft and branch to the loopback count
endpoint without stream, output-limit or sampling fields, shows the provider's
count for this draft, commits no message, keeps the draft, and clears the count
when the draft changes; with the OpenAI connection it reports that no counting
endpoint is published.
Branch navigation is explicit. The starting-branch list shows both root
branches; choosing the original commits it as the active path, shows
only its own messages, and lists its two regenerated responses as
continuations; choosing a response and then its user continuation commits each
step as the active leaf while the edited branch and its descendants remain
recorded. After the browser process restarts, the same lists switch branches
without any provider connected, and the stopped attempt is still shown with
its recorded interrupted status and sealed output.
Both connections are exercised for the provider-bound operations. Stop is
proven under the Anthropic and the OpenAI connection, regenerate under both,
and a prompt that asks the loopback fixture to identify itself streams one
extra delta naming the protocol, so a search for that text finds only what
the Anthropic connection streamed and opens the hit at the exact generated
part. Create, reopen, edit and search involve no provider themselves.
The credential boundary is checked directly. After every flow, the connected
session credential appears in no canonical record of any collection, no
provider request body, neither exported archive, browser storage or the
rendered document; only the host injects it into request headers.
Quote in reply appends the passage selected inside a message, or the whole
inline text of a sealed message when nothing is selected, as a Markdown
blockquote at the end of the draft with the caret placed after it. A quote that
would exceed the 16,384-character bound is refused with a visible notice and
the draft is unchanged; the quoted text then reaches the provider request.
A keyboard-only pass covers the core chat workflow without pointer input: the
skip link moves focus into the workspace; a new conversation focuses the
composer; sending keeps focus in the composer while the Send control is
replaced; Tab reaches Stop with a visible outline and stopping returns focus to
the composer; regenerate, edit (open, cancel, save), rename and search-result
open/close each leave focus on a named control rather than the document body.
During streaming the messages region is `aria-busy` and contains no live
region; the polite status line announces only at attempt boundaries. Every
button, link, field and summary on the page has an accessible name. WebKit
keeps links and buttons out of plain Tab order, as Safari does by default, so
that engine is driven with Option+Tab.
An invalid operator relay configuration leaves existing history, search and
conversation creation usable with unavailable provider connections. Missing
transports do not trigger spurious credential-reopen errors.
The reopened app loses browser-session credentials as designed. Narrow viewport
layout is checked for overflow; desktop and narrow screenshots were inspected.

Switching the composer to the OpenAI connection after an Anthropic attempt shows
a compatibility report for the active path: preserved parts by kind, transformed
and omitted counts, blocked parts with the adapter's reasons, the encoded request
size and a notice that the conversation will go to a different provider. The
report comes from the same mapping that builds the request ([ADR 0017](../decisions/0017-provider-switch-inspection.md)).
Sending stays disabled until a review scoped to that exact report is ticked.
The send then records an OpenAI attempt and, in the same commit as the user
message, a `ProviderSwitch` event whose `messageId` is that message and whose
preserved count equals the displayed report; the conversation header lists the
switch. The report also states the target's context window, the requested
output and the room that leaves for input, that token counting is unavailable for the OpenAI connection, and its reviewed rates; the recorded event keeps the room and
a null count. Selecting the previous connection again is a new switch with its
own unreviewed report; under the Anthropic target an explicit prompt count
compares the draft and branch with the room, states the spare tokens and
estimates the input cost at the reviewed rate beside a bound for the requested
output, and the count is discarded when the draft changes. Counting is never
automatic because it sends the branch to the target. The open conversation
also states its portability across every configured target with one reason
each: the comet conversation is fully portable for both connections, a seeded
conversation whose assistant turn carries reasoning metadata is blocked for
both with the adapter's `content_mapping` reason, and after the restart with no
connection the status is explicitly unknown. A stored fallback (OpenAI ·
GPT-4.1 mini for the Anthropic primary, same privacy class) is persisted in the
thread's routing profile; a synthetic 503 from the Anthropic loopback then
yields a failed Anthropic attempt and a complete OpenAI attempt under the same
user turn, with an `AutomaticFallback` event committed in the fallback
attempt's own transaction that names the primary attempt, its status, the
failure code and the reason, the fallback's answer as the active leaf and a
"Fell back" line in the header. An in-stream error after three deltas leaves a
partial Anthropic attempt with its committed text beside the complete fallback,
and a user stop records a cancelled attempt with no fallback. After the restart
the stored policy is shown by id as not configured. The routing profile then
chooses the route before the first attempt: a minimum context window the
selected Anthropic model does not meet routes the send to the OpenAI candidate
with an `AutomaticFallback` event whose primary status is not attempted and
whose reason names the requirement; a minimum no candidate meets refuses
sending with both reasons in the route line; clearing it restores the selected
connection; a credential the provider rejected routes the next send around the
selected connection from its recorded health; and a connection check restores
it. The synthetic ChatGPT
export is then imported through the production import panel (file chooser,
"Import history", completion status) and opened: its active branch carries a
provider artifact kept from unrecognised export content and is blocked for
both targets with the mapper's reason; the text sibling is chosen through
branch navigation and is portable with one transformation, the sketch the
export listed without its bytes, which is sent as a note naming the file;
selecting the Anthropic connection is a reviewed switch from the import origin
with an unknown privacy class that names that transformation; the request
carries exactly the imported path, the note and the new turn with no image
block; the recorded switch names the origin as imported with one
transformation; and every imported message and part is unchanged afterwards.
This check exposed and fixed a hard block: an image whose bytes this device
does not hold refused the whole path, so no imported conversation with a
missing file could continue anywhere. After the browser restart below, with no connection
configured, the event is still listed from its recorded ids. This check exposed
and fixed a defect: inspection and prompt counting after a stopped attempt
failed with "Generation cancelled before sending." because they reused the
stopped run's cancellation flag.

The view repository has three pinned-WASM SQLite tests covering pinned/recency
ordering, literal title filtering, bounded metadata, archive filters, stale
cursors, 101-message ancestor paging, sibling exclusion, foreign cursors and
subtree/whole-thread tombstones. Run
`node --experimental-transform-types --test packages/storage/tests/canonical/views.test.ts`.
The broader canonical suite includes the schema-7-to-8 upgrade and append-only
streaming regressions described in [ADR 0013](../decisions/0013-streaming-text-and-provenance.md).
All 32 canonical tests, 40 core tests and 19 search tests pass.
No product-scale latency claim follows from these fixtures.

Related independent acceptance:

- [Import panel evidence](../../packages/importers/docs/import-panel-browser-evidence.json)
  covers real chooser, restart/resume, warnings, report download and disposal.
- [Provider setup](../../packages/providers/docs/account-setup-validation.md)
  covers browser credentials and actual macOS native credential reopen/rotation.
- [Content rendering](../../packages/app/src/features/content/README.md)
  covers bounded Markdown/LaTeX, hostile content fallback, text-blob sections,
  local PNG/JPEG previews and verified downloads in both browser engines.

## Bounds and behavior

The library holds 24 summaries per page; a conversation window holds 12 messages,
with at most 64 parts/300,000 serialized bytes per visible message. Older windows
and subsequent part pages replace their predecessors. The selected part page
survives background updates. Library pages use explicit refresh after writes and
reject stale cursors. A single workspace UUID is retained in worker-owned local
metadata for new conversations; imported workspace identities are preserved.

The composer validates the complete selected ancestor path before dispatch. Its
current explicit limits are 2,047 prior messages, 2,000,000 serialized input bytes
and 16,384 typed characters. Oversized input fails visibly without silent history
truncation. Provider capability validation can impose stricter limits. Internal
raw-stream provenance remains in the archive and is excluded from model input.
Unknown semantic content still goes through adapter compatibility validation.
Maximum output tokens is editable when the adapter declares support; the selected
model's known maximum bounds it. The initial value is 1,024. Invalid settings do
not discard the typed draft or send a request. The setting applies to the next
send/regenerate and is recorded in that attempt's immutable request parameters;
it is not yet a persisted composer preference. Temperature, top-p and stop
sequences follow the same rule: shown only when the reviewed catalog permits
them, blank by default so the provider default applies, validated against the
selected model's protocol range (temperature 0–2 for OpenAI Chat Completions and
0–1 for Anthropic Messages, top-p 0–1, at most four non-empty stop sequences of
1,024 characters entered one per line), recorded per attempt and not persisted.
Quoting reads the browser selection or the message's inline text parts; blob-
backed long text and non-text parts are not quoted automatically, and the
notice says so. The draft is never truncated by a quote.

Focus policy: a control that disappears or becomes disabled after activation
(Send, Stop, Generate another response, Save edited branch, Close results,
Close selected content) hands focus to the composer or the search field, and
cancelling an edit returns focus to its opening button. The edit field opens
with the caret at the end. Streamed text is never placed in a live region;
`aria-busy` on the messages region signals updates without announcements.

Each streamed text segment is capped at 8,192 UTF-16 code units without splitting
a surrogate pair. Internal transport evidence does not close the active text
segment; other semantic parts do. Delta commits and raw-byte evidence remain
durable and independently ordered. Completed output stays sealed.

Export preparation streams through bounded transfers into host staging. Saving
is a separate user gesture. Ready export jobs can resume after restart; temporary
browser downloads remain until explicit completion confirmation and cleanup.
Restore activation is not exposed by this interface yet.

User text and branch selection commit before generation begins. Each response
has its own producer lease and canonical generation. Context/revision fences
prevent a changed prompt or branch from being silently attached to an attempt.
Background rendering follows current navigation intent; it cannot restore the
old branch after a successful edit. Unknown mutation outcomes retain the exact
batch identity for explicit reconciliation.

## Scale

`npm run test:app:scale:browser` seeds 2,001 conversations (each with one
message) and one 2,000-message conversation through the production Storage
Worker in bounded batches of at most 125 mutations, reopens the archive cold,
and drives the library, the long conversation and search with request
accounting. The retained
[scale report](../../packages/app/tests/browser/results/scale-browser.json)
finished at 2026-09-09T18:37:30.215Z on macOS 26.6.2; earlier
captures stay under `results/attempts/`. Every response's reported page size
stayed within the app's largest budget of 900,000 bytes, no whole-collection
read occurred, the library never rendered more than one 24-item page, and the
conversation never held more than twelve messages.

| Interaction | Chromium | WebKit | Reads |
| --- | --- | --- | --- |
| Seed through the worker | 5587 ms (67 batches) | 3808 ms | commits only |
| Cold library open | 234 ms | 252 ms | one `listLibrary` page |
| Title filter to one conversation | 128 ms | 64 ms | one `listLibrary` page |
| Next library page | 198 ms | 198 ms | one `listLibrary` page |
| Open the 2,000-message conversation | 98 ms | 44 ms | one window, twelve part pages, one children page |
| Three older windows | 65, 66, 64 ms | 120, 98, 42 ms | one window each |
| Back to latest | 66 ms | 119 ms | one window |
| Exact search and opening its hit | 66 + 69 ms | 78 + 70 ms | one search page, one resolve |

Timings are single runs under development load and are context, not
guarantees; the structural bounds are the acceptance evidence. Background
indexing of the roughly 4,000 seeded sources took 405 s in Chromium and
297 s in WebKit after the interactions finished; search was measured only
after it completed. Chromium's JavaScript heap after the scenario was
11,900,000 bytes used of 16,100,000 allocated.

The first capture exposed a scheduling defect: the worker ran a full
maintenance pass, including an indexing slice, inline after every foreground
call, so opening the long conversation during background indexing took about
2.3 s and each older window about the same. Maintenance now runs from a 50 ms
idle timer after foreground work ([ADR 0007](../decisions/0007-shared-chunks-and-lexical-search.md)),
which brought those interactions to the figures above without changing
indexing throughput. The shared app, documents, production client, search
navigation and extraction search suites pass after that change.

## Reusable routing aliases

Preferences now creates, edits, reorders and deletes aliases containing a primary,
ordered fallbacks and routing requirements. The composer applies an explicitly
reviewed snapshot through one canonical mutation and sync operation. The new
scenario proves lost-save recovery, stale-edit refusal, absent targets kept by id,
no draft loss or request during application, a fresh compatibility review before
an actual routed send, immutable copies after registry edits/deletion, and both
registry and canonical-profile persistence after process restart. A missing
primary is not silently replaced even while another connection is configured;
a deliberate replacement persists and detaches alias attribution. See
[routing alias acceptance](routing-aliases.md) for bounds, exact evidence and
remaining region/cost/compaction gates.

## Local preferences

The shared Preferences panel persists Enter versus Mod+Enter through typed,
worker-owned local metadata. The added scenario covers actual shortcut sends,
newlines and composition/repeat guards, lost-save reply recovery without losing
the draft, another client reading the choice and refusing a stale edit, and
process restart. Preferences are scoped to this archive on this device/profile
and excluded from portable exports; the SQL clean-copy proof confirms that
boundary. See [local preference acceptance](local-preferences.md) and
[ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md). The routing
scenario now also asserts that returning from a routed OpenAI attempt to
Anthropic requires a fresh switch review before sending becomes enabled.

## Open gates

Plan 08 remains in progress. This slice has not completed file (non-image)
attachment composition, remaining interaction preferences, attachment quoting, compaction and a local token estimate in the provider-switch report,
release-corpus latency on every supported host, the broader plan 13 focus/keyboard/screen-reader audit
(imports, exports, provider setup, scalable text, contrast),
audio playback or native end-to-end app acceptance. Text-only
user edits are supported when the complete inline text fits the editing bound;
other content retains its original representation and branch navigation.
Search is lexical; semantic indexing remains independent integration work.

The browser needs reviewed build-time relay configuration for live provider use;
without it, local library/import/search work and the provider screen explains the
unavailable transport. Malformed configuration likewise keeps local functionality
available and displays a notice without including the supplied configuration text.
Native composition registers the reviewed first-party
endpoints. `npm run check` and `cargo check --locked --workspace` passed. The
frontend build currently reports a chunk above 500 kB after rich rendering;
bundle splitting and measured startup performance remain release work.
