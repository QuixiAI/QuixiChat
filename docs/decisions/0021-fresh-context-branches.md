# 0021 — Explicit fresh branches for context compaction

2026-09-10. Decision implemented and verified in
[branch acceptance](../validation/context-branches.md). Product §38 offers
“Start a branch from here” when a conversation does not fit. A normal child
retains all ancestor context and therefore does not reduce it. This action starts
an empty root branch in the same conversation, with explicit review of that loss
of request context. It does not silently truncate or rewrite history.

The review is bound to the current archive selection, thread revision, context
and active leaf. It names what remains: current system prompt and routing,
existing attachment exclusion choices, and the unsent draft/staged attachments.
It names what does not carry into the new request: previous conversation messages
and applied summary text. The user can cancel without writing. Starting the branch
does not send a provider request or invent a message. The next explicit send
creates a root user message; existing starting-branch navigation can reopen the
original history. Until then, the selected leaf is null, which already means an
empty active path in the canonical model and request builder.

One expected-revision batch clones the current immutable context (clearing only
its applied summary), selects that context, sets the active leaf to null and
records ContextCompaction action `start_branch`. Its details are version 1,
`retainedContext: "system_prompt_only"`, `sourceThreadRevision`,
`sourceLeafMessageId`, `previousContextSnapshotId` and `contextSnapshotId`.
The event's messageId anchors the previous active leaf and generationId is null.
If a summary is cleared, the same batch includes the existing `clear_summary`
event required by ADR 0020. Existing exclusions and routing remain unchanged.
The worker validates this action against the pre-batch selected source and the
exact context/selection/audit mutations; unrelated destructive mutations cannot
be bundled into a claimed branch compaction.

This uses existing ContextSnapshot, nullable active leaf, ThreadEvent and
canonical mutations. Schema 12 / protocol 4 already represent the result without
new interpretation or new fields. No new schema or protocol gate is required.
Summary quality qualification remains separate. No external API changes or new
dependencies are involved.

An uncertain write keeps the exact batch pending. Reconciliation must reopen
the selection recorded by the batch (including null), rather than accidentally
restoring the previously displayed leaf. Counting is disabled while the outcome
is pending; a scope change during count preparation prevents late dispatch.
A new archive selection invalidates
review. Busy generation, stale revision/context/leaf, an already empty branch
or a pending canonical change refuse. Original history, contexts and proposal
provenance stay inspectable after restart and portable restore.
