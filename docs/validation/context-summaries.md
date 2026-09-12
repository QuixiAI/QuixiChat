# Reviewed conversation summaries

2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. This implements the summary
portion of product §38 / plan 10 under [ADR 0020](../decisions/0020-reviewed-summary-proposals.md).
Actual model fidelity remains open. The subsequent [fresh-branch slice](context-branches.md)
implements explicit branching and reruns these application checks; this document
and its reports retain the original summary iteration’s captured source revision.
No paid provider call or private history was used.

## Delivered behavior

The conversation offers a bounded cutoff review before a retained user turn.
Preparation verifies source text/image bytes, applies attachment exclusions
before reading their bytes, quotes historical evidence under a fixed summary
instruction, and includes a previous reviewed summary when extending it. The
review names the destination/privacy class, source IDs, omissions, output cap,
count and available cost estimates. Counting and generation require explicit
request review. Unknown artifacts, unsupported files/audio, unavailable required
bytes, unfinished tool exchanges and oversized discovery refuse visibly.

A verified RawObject retains the exact prepared provider body without headers
or credentials. A typed SummaryProposal links it to the source fingerprint,
context/revision/leaf/cutoff and a separate summary-purpose Generation with an
unselected request context. Generating it never selects the output as a chat
answer. Proposal usage is identified separately within inclusive conversation
totals. Search labels proposal outputs; ordinary transcript/branch selection
and continuation refuse them. Saved proposals and their verified inputs remain
inspectable without a configured provider.

Only complete sealed nonempty inline Text output up to 16 KiB UTF-8 is eligible,
with recognized transport provenance retained separately. Partial/stopped/failed,
non-text, blob-backed and oversized generated outputs cannot be applied. The
stream cap saves a partial prefix even when transport cancellation rejects.
The person may edit the proposed text; a separate review is required before
application. Generated text and original source records remain unchanged.

Apply/clear require the current selected context predecessor and expected thread
revision, with the matching ContextCompaction event in the same canonical batch.
The worker recomputes source freshness on creation/application, checks cutoff,
output eligibility and reviewed-text digest, and rejects stale or foreign scope.
An unknown apply reply leaves the original batch pending; the existing recovery
button retries that exact transaction identity. Archive-selection or target
changes cancel pending review/count work and suppress late results.

The common request path prepends the exact labeled reviewed text and reads only
the retained tail's parts/blobs. Inspection, portability, counting, sending,
regeneration and automatic continuation fallback use it. Earlier/divergent
branches refuse instead of silently restoring full history. The original system
prompt and tail exclusions remain effective. Clear creates a new snapshot with
summary null and keeps exclusions. Editing exclusions keeps the applied summary.
Prompt counts now expire when draft, branch/revision/context, target/settings or
attachments change; a late count cannot be reused for another scope.

Bounds: 2,047 new source messages, 4,096 source parts, 512 KiB source metadata/text,
4,096 review requests, 8 MiB returned review metadata, the existing provider image
byte limit, a 4 MiB frozen request and 16 KiB generated/reviewed text. Proposal
lists page 16 records and load output/input only on inspection. These are refusal
limits, not permission to truncate source history.

## Verification

[Unit/build report](results/context-summaries-unit-macos.json):

| Command | Result |
| --- | --- |
| `npm run test:core` | 54 passed |
| `npm run test:storage:canonical` | 50 passed |
| `npm run test:providers` | 32 passed |
| `npm run test:app:summaries` | 18 passed |
| `npm run test:app:switching` | 26 passed |
| `npm run test:app:health` | 7 passed |
| `npm run test:app:preferences` | 7 passed |
| `npm run test:app:attachments` | 9 passed |
| `npm run check` | SQLite verification, typecheck and both frontend builds passed |

The **203 Node tests** include independent fingerprints, verified/deduplicated
images, exclusion-before-read, source/tool/branch limits, fresh and repeated
proposals, current attachment availability, output/UTF-8 eligibility, edited-text
hashes, atomic audit pairing, rollback/replay/reopen, migration refusal, separate
usage/search labels, cancellation, selection changes and late-response suppression.
The real library-controller tests verify the pending global error and strictly
identical replay batch, and refusal to display a proposal as an ordinary answer.

[Shared application report](results/context-summaries-app-macos.json): **35 groups
in each of actual Chromium and Playwright WebKit**. Production host/adapters
send controlled loopback HTTP into the real Storage Worker/OPFS archive. New
checks compare the captured proposal body to the prepared and re-read frozen
body and its independent SHA-256; enforce both review steps; apply edited text
through a lost durable reply; check one audit event and unchanged source records;
compare summary context in count/send/regenerate/failed-primary/fallback bodies;
verify attachment markers in a separate failed-primary/fallback pair; include
prior reviewed text in a later proposal; retain cancelled output as ineligible;
and reopen the same archive in a fresh browser process. Applied text, generation,
frozen bytes and summary/fallback events survive; clear works offline and retains
exclusions. Mobile layout has no horizontal overflow. The
[Chromium review](results/context-summaries-chromium-review.png),
[WebKit review](results/context-summaries-webkit-review.png) and both
[Chromium](results/context-summaries-chromium-mobile.png)/[WebKit](results/context-summaries-webkit-mobile.png)
mobile views were visually inspected.

The integration runs exposed and fixed a missing canonical blob reference on
frozen input, failure to expose pending-apply reconciliation globally, and stale
ordinary prompt counts after branch changes. The worker's refusals were retained.
The summary scenario uses its own synthetic conversation so the alias proof's
intentional 500,000-token routing requirement remains unchanged.

[Provider browser regression](results/context-summaries-providers-macos.json):
23 existing real-storage checks per engine pass. Summary-specific output-cap
cases are the Node checkpoint-sink tests, not a claim that these 23 browser
checks exercise every cap fault.

[Archive report](results/context-summaries-archives-macos.json): 13 Node archive
tests and both real browser snapshot proofs pass. The schema-12 fixture includes
the proposal, purpose generation, frozen verified input, edited reviewed text and
exclusions; portable restore preserves every canonical record, reference edge and
journal operation, with blob integrity checked. It is separate from the genuine
schema-8 portable upgrade fixture.

Schema **12** adds the per-generation proposal index and fences older writers;
archive protocol **4** isolates older followers. The [protocol report](results/context-summaries-protocol-macos.json)
passes six groups per engine, including older envelopes and the actual frozen
schema-8 worker. [Production activation](results/context-summaries-activation-macos.json)
passes nine per engine; [retained archive/recovery](results/context-summaries-retained-macos.json)
passes twelve; [public extraction](results/context-summaries-extraction-macos.json)
passes seven; [retained extraction](results/context-summaries-retained-extraction-macos.json)
passes five. Search regressions also pass: source navigation 7, image search 6,
conversation search 7 and extraction/search 10. Their retained reports are
listed in the unit/build report. Current report source hashes were verified;
earlier attachment/design build reports remain historical checkpoints.

## Remaining gates

The [design experiment](context-summary-design.md) was rerun: 24 Node tests and
24 checks per browser, with ten authored quality cases, 19 required claims and
ten faulty controls. **Zero actual model runs were performed.** Synthetic stream
text and authored reviewed summaries prove transport/storage/review behavior,
not factual reliability, compression quality or resistance to quoted instructions.
Qualification still needs captured model outputs, independent claim grading,
repeated compaction and downstream question cases. Use a redistributable local
model or an explicitly authorized provider run; no spending/private-data
transmission is authorized by this iteration.

The explicit branch compaction choice, remaining routing constraints, native
Tauri/cross-host proof and release-scale qualification remain open. Playwright
WebKit does not establish installed Safari or native host support. The existing
large frontend-bundle warning remains. No numbered plan is declared complete.
