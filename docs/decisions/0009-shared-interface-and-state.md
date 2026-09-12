# 0009 — React for the shared local application

Status: Accepted; implementation begins in plan 08.

Use React and React DOM in `packages/app`, built by the existing Vite hosts.
Web and Tauri mount the same component tree and inject their StorageClient,
HostClient and provider configuration at the composition boundary. Platform
capabilities stay in the hosts; component code does not open SQLite, read OPFS
directly or choose a different persistence implementation.

Quixi needs a persistent, interactive local workspace with streamed output,
branches, paginated history, import progress and accessible controls
([product section 29](../product.md#29-core-chat-experience)). React supplies a
shared component/lifecycle model and integration with existing Markdown/math
renderers. The current plain DOM scaffold remains useful for isolated developer
proofs, but expanding it into the complete product would require maintaining a
parallel component and subscription system. A server rendering framework adds
little to an archive held in a local worker and increases the Tauri composition
surface. React's [client application guidance](https://react.dev/learn/build-a-react-app-from-scratch)
documents this build-tool approach and its routing/data-loading responsibilities.

Canonical state remains authoritative in the storage worker. Application stores
hold bounded query pages and immutable snapshots, subscribe to storage change
notifications, and invalidate affected pages after durable commits. React uses
[`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
for these snapshots. Component reducers/state own transient drafts, expanded
panels, focus and pending presentation. A draft or streamed presentation buffer
does not imply a committed message. No archive-wide normalized client store is
introduced, and a long active path is fetched/rendered in windows.

Mutating workflows live outside rendering: stable operation identities,
unknown-outcome reconciliation, import run locks and generation producer leases
survive component rerenders. Root unmount unsubscribes and disposes owned
resources; asynchronous completions cannot update an abandoned query scope.
Provider and import execution use the existing bounded workflow interfaces.
UI transitions never automatically repeat an uncertain provider request.

Navigation uses explicit archive/thread/message/document identifiers and browser
history, with source-specific loading; a search result does not require loading
the full archive. A router may be added when the actual route hierarchy warrants
it. Native HTML controls, semantic regions and focus management are the baseline;
CSS variables carry appearance preferences. Imported/model text is displayed as
text or through a reviewed renderer with raw HTML disabled.

Pin React/React DOM 19.2.8 and their TypeScript declarations in the lockfile.
`createRoot`/unmount is the shared host mount boundary, following the
[official API](https://react.dev/reference/react-dom/client/createRoot).
This decision does not itself deliver the chat UI or satisfy plan 08 acceptance;
the real browser/desktop workflows must prove those requirements.

## Async panel focus — 2026-09-10

Preferences, providers, import, export and restore use a shared focus boundary.
When the focused control becomes disabled, a stable, programmatically focusable
panel heading holds the keyboard position. The original control regains focus
when enabled; if it was removed, the heading remains the destination. External
focus or pointer movement, or deliberate blur of an enabled origin or parked
heading, cancels recovery. A disabled interval observed while
a native dialog owns focus is remembered until document focus returns; merely
finding focus on the document body does not authorize recovery. Unmount removes
listeners and pending recovery. Focus changes do not replay actions or I/O.

Opening an imported conversation instead hands focus to that conversation's
heading after its view loads, provided focus still rests on the body and the
requested conversation remains visible. This explicit navigation destination
belongs to the parent that replaces the import panel.

Import and archive live regions contain phase names and outcomes; changing byte
and record counts remain readable outside their live subtree. Qualification and
its limits are recorded in [keyboard focus](../validation/keyboard-focus.md).

The [review accessibility extension](../validation/review-accessibility.md)
keeps compaction and alias focus boundaries mounted when their inner reviews
close or consent becomes stale. Enabled-control focusout during synchronous
React removal is resolved after the commit with a unique pending-blur marker:
detached controls receive recovery; deliberately blurred controls still in the
document do not. User focus/pointer movement and unmount invalidate the marker.
Fresh-branch consent retains the same source key, while its boundary survives
that key's changes. Fresh-branch completion no longer overrides user focus with
an unconditional composer handoff.


The [action-accessibility increment](../validation/action-accessibility.md)
separates compatibility announcements from the changing inspection details. One
persistent atomic status retains the last settled semantic result while a fresh
check runs, with explicit historical wording and scope invalidation on thread,
context, branch or target change. Detailed reasons remain readable without
individual alerts. Inspection/review keys and all request guards remain the
source of permission; announcement de-duplication has no authority over sending.

Workspace notices and conversation routing use separate stable focus boundaries,
so their disappearing controls recover without capturing focus from unrelated
panels. Message/action names use speaker and current-page position, keeping names
bounded and independent of streamed content or whole-history materialization.

The conditional routing section owns its focus hook inside a child component.
Keeping that hook in AppRoot would let it outlive the section and skip listener
installation when its root initially did not exist. The imported-conversation
focus regression exposed this lifecycle mismatch; panel removal now performs
hook cleanup before later navigation or re-entry.

Once Workspace status receives recovery focus, its heading stays visible for the
session rather than collapsing on blur. This keeps a pointer's next target at
its original position through down/up. Unknown-outcome errors cannot be dismissed
while the pending transaction requires reconciliation; known refusals can be
dismissed normally. Both the control and controller enforce that distinction.


The [pending-recovery increment](../validation/pending-recovery.md) replaces the
ordinary-error ownership of reconciliation with an explicit pending-recovery
record. Dismissing an ordinary error is safe because the original unknown outcome
and its recovery action remain separately available. Origin metadata is captured
at admission, while the exact transaction/mutations are cloned and frozen.
Concurrent checks share one operation; navigation epochs distinguish a newer
explicit selection from automatic refresh. Acknowledgement and subsequent read
failures are separate outcomes, so a failed view refresh cannot revive a resolved
unknown transaction.
