# 0020 — Reviewed summary proposals and prefix replacement

Date: 2026-09-10. Status: implemented with controlled integration evidence;
model fidelity qualification remains open. Extends [ADR 0019](0019-reviewed-context-compaction.md)
and product §38. The production path uses schema 12 / archive protocol 4.
[Implementation acceptance](../validation/context-summaries.md) records its
worker, UI, request and archive proofs. The executable
[design experiment](../../research/context-summary/README.md) remains outside the
product dependency graph and performs no model inference.

## Findings from the current implementation

The [chat attempt wrapper](../../packages/app/src/workflows/chat.ts) selects its
output in `onCreated` and reloads that branch. Reusing it unchanged would select
a proposal before approval. The underlying [generation coordinator](../../packages/providers/src/generation.ts)
can create and stream an attempt without that selection callback; `createWith`
commits explanatory records with generation creation. Creation and streaming do
not increment ThreadState.revision; state changes do. Revision plus selected
context/leaf therefore remain a useful review fence while a proposal streams.

Generation.contextSnapshotId currently describes the attempt's system prompt.
The coordinator records normalized parameters and a response manifest, but not a
complete request manifest. A summary-specific system instruction cannot be
silently substituted while pointing at the ordinary prompt snapshot. A proposal
needs an unselected request context and a frozen input record in addition to the
original source context reference.

Context versions advance from their immutable predecessor; only version 1 is
unique per thread. Unselected proposal context snapshots can branch from the
current snapshot without changing its selection or reserving a global version
counter. `CreateContextSnapshot(select:false)` already supports this. Its initial
publication precedes coordinator creation because `createWith` runs after the
CreateGeneration mutation and the generation requires an existing context.

Canonical tool results have either a resolved call-part reference or an explicit
provider-call identifier. The latter is not proof that a boundary is safe. The
boundary validator must resolve it against preceding outstanding calls and
refuse ambiguity, duplicate results, orphan results and unfinished exchanges.

## Chosen canonical representation

Introduce a typed immutable `SummaryProposal` collection with one proposal per
generation, a `RegisterSummaryProposal` canonical mutation, and an optional
`Generation.purpose: "context_summary"`. An absent purpose remains ordinary chat.
Do not overload user settings, routing JSON, a mutable message or arbitrary event
JSON as the authoritative request policy.

Proposed SummaryProposal version 1 fields:

| Field | Meaning and validation |
| --- | --- |
| id, threadId, recordedAt | Canonical identity and owner |
| generationId | Same-thread summary-purpose attempt; one proposal per attempt |
| sourceContextSnapshotId | Exact selected policy before proposal creation |
| requestContextSnapshotId | Unselected snapshot containing the fixed summary instruction; must equal the generation's context |
| throughMessageId | Inclusive terminal message of the covered prefix; must equal the generation parent |
| baseSummaryProposalId, baseSummaryContextId | Both null for the first summary; otherwise the prior reviewed summary and snapshot included as evidence |
| sourceMessageCount, sourcePartCount | Newly covered source counts, checked against complete sealed records |
| sourceFingerprint | SHA-256 of the versioned canonical source descriptor, including path identity, parts, applicable attachment state and prior reviewed summary |
| inputRawObjectId | Verified canonical raw object containing the exact prepared provider body, without transport credentials/headers |
| inputSha256, inputByteLength | Must agree with the raw object/catalog; encoded body remains independently inspectable |
| promptTemplateVersion | Explicit version of the summary instruction and evidence serialization |

The descriptor separates canonical evidence identity from the exact provider body:
`sourceFingerprint` detects changed dependencies; `inputSha256` reproduces what was
sent. A digest alone is not proof that the provider received those bytes. Real
controlled-HTTP tests must compare the captured request with the frozen body.
The Storage Worker validates canonical links and descriptor freshness; shared
workflow/adapter tests establish source-to-wire agreement. Archive validation
must check both typed references and verified raw input bytes.

Compaction version 2 retains `excludedPartIds` and adds nullable `summary`:
`{proposalId, throughMessageId, reviewedText, reviewedTextSha256}`. These fields
are strictly validated, including matching proposal boundary, a complete sealed
summary generation, the selected source/base scope, exact UTF-8 text digest and
bounds. The reviewed text may differ from generated text: record that fact in
the application event and preserve both. Never rewrite the generated parts.

Applying creates/selects a new ContextSnapshot and creates ContextCompaction in
one expected-revision transaction, with both sync operations. The event names
proposal, generation, previous/new snapshot, cutoff, source fingerprint, reviewed
text digest and whether the user edited the proposal. Clearing makes a new
snapshot with summary null and retains the independent attachment exclusions.
Retry the exact transaction after an unknown outcome; never manufacture a second
proposal/application identity merely because the reply was lost.

The implementation uses ledger 12 and archive protocol 4, with strict refusal
of unknown policy/purpose versions, explicit reference edges, normalized import
handling, portable/rescue copies, retained reading and older-owner/follower tests.
Schema 12 adds a unique proposal-per-generation index. Schemas 10 and 11 upgrade
without rewriting canonical records; the schema-8 migration fixture remains
separate from the new summary fixture.

## Proposal lifecycle and user review

1. Open a bounded source review. Choose a cutoff before a retained user turn,
   show source scope, retained tail, prior summary if any, attachment transforms,
   target model, privacy/capability report, output cap and available cost/count
   information. Generation sends evidence; opening the review does not.
2. Freeze the source descriptor and exact prepared body as verified staged bytes.
   Recheck selected archive/revision, thread revision, context, leaf and source
   dependencies. Publish raw input plus an unselected request context through
   ordinary canonical commits. Interrupted preparation may leave inspectable
   unselected records; it cannot select a policy or send a request.
3. Start the coordinated generation with summary purpose, parent=cutoff and the
   unselected request context. Register SummaryProposal and its proposal-started
   ThreadEvent atomically with the generation. The worker validates source scope
   at that transaction. Do not call the ordinary chat selection callback.
4. Stream into the canonical attempt. Stop/cancel/provider failure/partial output
   remain recorded, but only a fully complete, sealed, text-only output within
   the summary bound is eligible for review. Cancel preserves current context
   and source history; output beyond the cap is stopped and marked ineligible,
   never clipped into an apparently complete proposal.
5. Show exact generated text and source evidence together. Edits invalidate the
   prior confirmation. The final review key includes selected archive/revision,
   thread revision/context/leaf, proposal and generation identities, source
   fingerprint, generated-text digest and exact reviewed text. Application
   repeats those checks inside the worker transaction.
6. After commit, refresh the selected view before allowing ordinary sends/counts.
   Keep the summary visible with source and proposal inspection and a clear
   action. Invalid/stale review returns to review; it never applies to a newer
   branch. Process restart finds proposals by bounded same-thread pagination;
   streaming producer recovery leaves interrupted attempts ineligible.

Summary-purpose outputs remain canonical, searchable and inspectable with a
clear label, but they are excluded from normal sibling-answer/branch choices.
Ordinary SetActiveBranch/CreateMessage must refuse selecting/continuing a summary
output. A deliberate future conversion would be a separate audited operation.
This prevents a proposal from becoming normal chat through a generic branch menu.
Include summary usage/cost as a visibly separate category in conversation totals.

Automatic summary-generation fallback is not implicit consent to a different
processor: reuse the reviewed target/privacy constraints, record each attempt,
and require a new review if those constraints change. An ordinary answer after
application reuses the already effective summary-plus-tail input for fallback.
The UI must distinguish the summary generation count from the post-application
continuation count; neither is a promise of semantic quality or token savings.

## Prefix, branch and repeated-summary rules

Choose a nonempty contiguous older prefix ending before a retained user turn.
Resolve complete tool exchanges before offering boundaries; no pair may straddle
one. Keep tool call names/arguments/results/status as quoted historical evidence,
not executable tools. No outstanding or ambiguous exchange is silently discarded.
Preserve partial/failed assistant status in the evidence so it cannot be presented
as a successful tool or completed answer. A structural rule cannot guarantee that
a model respects this distinction; the fidelity corpus tests it separately.

After application, requests walk backward from the selected leaf only as far as
the stored cutoff, then stop before reading its parts/blobs. Prepend the exact
reviewed summary as a labelled user Text part, followed by the retained tail under its existing attachment exclusions.
Retained source records stay unchanged; exclusions still replace their selected
occurrences before attachment reads. The current user-configured system prompt remains the system prompt. The
summary is historical evidence, never promoted to a system/developer instruction.
Inspection, counting, send, regenerate and ordinary fallback share this builder.
Fresh attachment maps contain only parts actually included in that request.

A branch diverging before the cutoff cannot use the summary. Refuse with an
explicit choice to clear/review context or return to a descendant branch; never
silently substitute the full old history or apply another branch's summary. A
regeneration parent earlier than the cutoff is likewise refused. Missing or
hidden dependencies after tombstoning require fresh review/clearing. Export keeps
all original source and proposal records. Deletion/GC must respect those edges.

For another compaction, include the previous **reviewed** summary plus only the
newly covered messages. Bind the prior proposal/snapshot/text digest explicitly
and disclose that the new proposal summarizes an earlier summary. The boundary
must advance and cannot cross an open tool exchange. The prior source chain stays
inspectable. Do not recursively expand all historical source while sending a
normal request. Bound evidence-inspection depth/paging independently. Moving a
cutoff backward requires clearing/reviewing original source, not pretending the
old compressed prefix can be recovered from summary text.

## Budgets and content handling

Initial design budgets are at most 2,047 newly covered messages, 4,096 source
parts, 512 KiB UTF-8 serialized textual evidence, 16 KiB UTF-8 reviewed/generated
summary text and 2,047 retained messages. These are implementation bounds, not
model context estimates. Storage reads stay within existing page/transfer limits;
cap the review at 4,096 requests and 8 MiB returned metadata, cancel pending work,
and refuse partial discovery. Sum image bytes separately under the existing
provider image cap. Apply the selected model's context/output limits and ordinary
provider count/compatibility checks before spending an attempt.

Large blob-backed text requires verified bounded decoding; its hash is not a
substitute for its content. Images require the selected adapter's verified image
mapping with explicit source attribution and budget review. Unsupported file or
audio content refuses until mapped or explicitly excluded. Exclusions run first,
so omitted attachment names, descriptions and bytes do not enter the proposal
input. Redacted reasoning and recognized internal transport artifacts remain omitted
with visible counts. Preserve non-redacted visible reasoning summaries as quoted
evidence; unknown provider artifacts refuse instead of being silently discarded. No HTML/file/document instruction is executed while preparing evidence.
The test model exercises inline text/tool JSON and explicit refusal for content
requiring a real verified reader; it does not claim to implement those readers.

## Fidelity qualification

The [original synthetic corpus](../../research/context-summary/quality-fixtures.json)
has ten cases with source-linked required claims, authored acceptable summaries
and deliberately faulty controls. It covers updated facts, negation, unanswered
questions, attribution, failed tools, exact identifiers/Unicode, quoted hostile
instructions, chronology, excluded attachments and partial output.

Use two independent measures for an actual model run: required-fact retention
and unsupported/contradicted claims, plus readability and source attribution.
All critical fixture facts must survive; no unsupported or contradicted critical
claim is permitted. Inspect the faulty controls to verify the grading procedure
can detect the intended errors. Record exact prompt version, frozen request,
model/provider metadata, complete output, tokens/cost, source hashes and grading
notes. Evaluate repeated-summary and subsequent question-answering cases as well
as one-pass summaries. User review remains required after quality qualification.
Do not grade factuality using token savings or keyword overlap alone.

Research basis, read 2026-09-10:
[LongMemEval v2](https://arxiv.org/abs/2410.10813v2) evaluates extraction, temporal
reasoning, updates, cross-session reasoning and abstention. Those dimensions
inform the correction/chronology/unknown-answer fixtures here; this corpus is not
a LongMemEval reproduction or score.
[SummEval v4](https://arxiv.org/abs/2007.12626v4) compares automatic summary metrics
with expert/crowd judgments. Our inference is to keep human fidelity review and
separate factual retention from compression size. No external dataset, model
artifact or new dependency was downloaded for this decision.

## Review outcome and implementation order

Accepted: dedicated typed proposal provenance, unselected request context,
summary-purpose attempt, immutable reviewed text, one atomic apply/event,
boundary-aware request traversal, strict stale/branch handling and explicit
fidelity gates. Rejected: immediate active-branch generation, fake manual text
presented as model output, overwriting old messages, putting a summary into the
system prompt, retaining only a digest with no frozen input, and a success claim
based on authored fixture summaries.

The proposal → review → atomic application increment is implemented and has
controlled Chromium/WebKit HTTP and archive evidence. Actual model-quality runs
remain separate: zero have been performed. Explicit compaction branching and
all other open plan-10 requirements remain in scope.

## Implementation refinements

- Worker apply/clear transitions require the current selected predecessor,
  expected thread revision and matching ContextCompaction event in the same
  batch. Changing reviewed text, even for the same proposal ID, invokes fresh
  source checks. Unselected request contexts and exclusion/system-prompt edits
  retaining the same summary do not count as summary transitions.
- Source fingerprints include current attachment availability. Creation and
  application recompute them; archive/static validation checks stored provenance,
  input bytes/digest, boundary and output eligibility without pretending current
  attachment availability reconstructs historical input. A later legitimate
  attachment resolution must not make an old, already-applied summary archive
  unrestorable. The separately retained request body preserves the old evidence.
- Applicable generated output is nonempty inline Text, at most 16 KiB UTF-8,
  plus recognized transport provenance only. Other parts, blob-backed text,
  partial/stopped/failed output and incomplete tool exchanges refuse. The stream
  limit retains a sealed partial prefix even if transport cancellation rejects.
- Summary usage is an explicitly labeled subset of inclusive conversation totals.
  Searchable proposal outputs are labeled and cannot open as ordinary transcript
  answers; saved-proposal inspection remains available without a provider.
- Target changes and archive-selection changes cancel pending review/count work;
  late replies cannot restore an old review. Ordinary prompt counts now expire
  with draft, branch/revision/context, target, settings or attachment changes.
- Summary generation uses one explicitly reviewed destination. Automatic
  continuation fallback reuses the effective reviewed-summary-plus-tail input;
  generating a proposal does not authorize sending it to another destination.
