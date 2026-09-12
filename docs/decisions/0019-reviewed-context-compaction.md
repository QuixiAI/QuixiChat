# 0019 — Reviewed context compaction

Date: 2026-09-10. Status: accepted; attachment exclusion implemented and verified.

Product §38 and plan 10 require explicit choices to summarize older messages,
exclude selected attachments, start a branch, or cancel, without silently
truncating canonical history. Current request construction is bounded to 2,047
prior messages and two million serialized text bytes, with a separate image
budget. All inspection, counting, sending, regeneration and fallback paths must
agree on the effective context.

## Canonical representation

Add optional, versioned compaction data to immutable ContextSnapshot, separate
from routing and the system prompt. Applying or clearing an attachment exclusion
creates/selects a new snapshot and a ContextCompaction event in one canonical
transaction with both sync operations and the expected thread revision. Each
generation already records its context snapshot id, so past attempts retain the
choice used for them. Editing the system prompt copies the selected policy;
changing branches applies it only to the referenced occurrences present there.

The first policy is `{version: 1, excludedPartIds: UUID[]}` with at most 64 unique
part ids. Each id must reference an Image, File or Audio part in the same thread.
These are exact occurrences, not a blob hash rule: future/new attachments and
other references to the same bytes are not implicitly excluded. The UI states
this scope, shows the selected occurrences and keeps prior choices outside the
active branch visible. Unknown/malformed policy versions refuse requests.

No original message, part, attachment, blob or raw source is changed. Policy
references participate in canonical and archive validation. Portable archives
retain snapshots, references, events and original bytes. Restore must validate
these semantics. Schema 11 is a format gate even though the payload fits the
existing JSON column: schema-10 and older writers must reject the newer ledger
rather than silently send attachments whose exclusions they do not understand.
Archive transport also advances to protocol 3, on a version-3 broadcast channel
with strict versioned envelopes. Protocol-2 followers cannot borrow a newer owner
to read/send without honoring exclusions. The common owner lock remains unchanged;
a waiting old owner still refuses the schema-11 ledger when it acquires the lock.

## One request transformation

Before reading any attachment bytes, the shared context builder replaces each
excluded occurrence with the exact plain-text marker
`[Attachment omitted by your context choice.]`. It does not send its filename,
description, attachment id or bytes. A marker preserves turn roles when an
attachment was the only content. Compatibility/portability reports call this a
transformation and count it explicitly. Provider adapters still validate the
effective request. Counting remains an explicit provider action.

The snapshot id joins the app's compatibility and portability cache keys, and
changing it invalidates token counts and prior switch confirmations. The actual
send rechecks the thread/context revision before an attempt. The preview is a
configuration review, not authorization to send; an ordinary consequential
provider switch still needs its own compatibility review.

## UI, work bounds and recovery

A separate bounded controller reads ancestor message windows and part pages,
collecting at most 64 attachment occurrences, with a maximum of 2,047 messages
and a finite metadata request/byte budget. It supports cancellation and rejects
stale results if the thread, leaf, context or revision changes. It does not read
attachment bytes or call a provider. Failure or cancellation preserves the
current policy and draft. No partial discovery is presented as the whole branch.

The editor starts from the current exclusions, offers a review checkbox and an
explicit apply/clear choice. Apply binds to the exact reviewed thread revision;
unknown write outcomes reuse the existing canonical pending-transaction recovery.
Sending and related context changes wait for application and refreshed views.
Events describe the selected or cleared occurrences after reload, and source
inspection still reaches original parts. No automatic token-savings claim is
made: the provider's explicit count determines whether the effective prompt fits.

## Later choices (remain in scope)

Summarization must retain a bounded older-prefix boundary, the exact reviewed
summary text, its generating attempt/provenance and source scope in immutable
canonical records. A generated summary is proposed, then reviewed before it
affects requests. Cancellation or failure cannot replace history. Tool exchanges
must remain intact at the retained boundary. Provider context/output limits and
cost/privacy choices must apply to the summary request too. Decide the concrete
prefix/reference schema and run quality fixtures before exposing this choice.

Branching must record the chosen cutoff/branch action as ContextCompaction while
preserving all prior branches; simply navigating a branch must not manufacture
a compaction event. Neither this action nor summarization is exposed by the
attachment-only slice. These remain plan 10 tasks and acceptance gates.

## Review and evidence

No new external API or dependency is introduced. Reuse existing canonical
transactions, worker ownership, provider mappings and bounded reads. Avoid
placing a request policy in local preferences, routing JSON or mutable message
parts: none would correctly bind the policy to recorded generation context.

Required evidence: strict shape/reference checks, atomic rollback/replay,
old-ledger upgrade/new-ledger refusal, cancellation/stale discovery, identical
effective content in inspection/count/send/regenerate/fallback, exact archive
round-trip and unchanged originals, Chromium/WebKit UI/restart proofs. Native
host/release qualification remains explicit; a frontend build cannot prove it.

[Recorded implementation evidence](../validation/context-compaction.md) links the
final unit/build, Chromium/WebKit, schema-11 portable restore, protocol-3 and
activation results, including remaining combined-scenario and native limits.

The later summary design is now specified and tested as a design model in
[ADR 0020](0020-reviewed-summary-proposals.md). Its production implementation and
actual model-quality qualification remain open; attachment policy v1 is unchanged.
