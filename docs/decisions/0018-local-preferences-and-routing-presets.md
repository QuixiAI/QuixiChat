# 0018 — Local preferences and routing presets

Date: 2026-09-10. Status: accepted; interaction preferences and reusable aliases implemented.

Product sections 33–34 and 92 require reusable routing profiles and interaction
preferences independent of appearance. Plans 10 and 13 share this persistence
decision; the first implementation is Enter versus Mod+Enter in plan 08's composer.

## Ownership and scope

Use typed StorageClient operations backed by the existing worker-owned
`quixi_local_state` table. Preferences apply to all conversations in this archive
on this device/browser profile and origin. They are local metadata, not canonical
history or sync operations. The shared app must never open SQLite or use a
parallel localStorage/native settings database. Both host entries inherit the
same implementation through AppRoot.

The first closed schema stores only a version, revision and send-key choice.
Absent data yields the current Mod+Enter default without writing. Invalid or
future-version data is refused visibly and preserved. Future appearance and
interaction fields must be separately named; changing a theme cannot change a
send key. Do not expose unimplemented preferences.

The existing clean-copy archive policy exports only `defaultWorkspaceId` from
local state. Keep that policy: portable/open exports and cleaned rescue restores
do not carry preferences. Byte-level rescue still contains the original database
bytes. Opening a replacement archive uses that archive's local preferences or
defaults. UI text states this scope. This does not change canonical archive
fidelity or provider credential ownership.

## Concurrency and failure

Each preference write carries the revision last read and uses a conditional SQL
write; a stale tab cannot overwrite a newer setting. Requests use the normal
bounded queue and active-archive selection fence. No unbounded settings map or
new durable operation journal is needed. A lost reply is reconciled by reading
the current setting before a deliberate reapplication, never blindly replayed.
Reads happen on mount, settings entry and window focus; no canonical change
notification is manufactured for a local preference. An in-flight read/save is
exclusive within the controller. Keyboard submission is unavailable until a
read/save has succeeded; button submission and local history remain usable.
Errors offer a reload action, retaining the stored row and unsent message.

## Keyboard behavior

Default Mod+Enter sends; Enter inserts a newline. Enter mode sends on unmodified
Enter, Shift+Enter inserts a newline, and Mod+Enter remains a send shortcut.
Composition and repeated keydown events never submit. The shortcut uses the
same send validation and review as the button. Changing the preference never
rewrites a draft or sends it. The visible hint describes the loaded choice.

Reviewed 2026-09-10: [MDN isComposing](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing)
and [MDN repeat](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/repeat).
Use composition events as well as the keyboard flag. Automated DOM events cover
the guards; installed OS input-method behavior still needs native qualification.

## Routing follow-up and alternatives

Reusable aliases occupy a separate typed, bounded local settings record,
with ordered candidates and the existing profile constraints. Selecting one must
copy its resolved profile into canonical ThreadState using SetRoutingProfile;
future edits to an alias must not silently change an existing conversation or
reuse a switch confirmation. Credential handles remain host-owned, and missing
connections remain inspectable by id. Implementation and evidence are in [alias acceptance](../validation/routing-aliases.md);
region and pre-count cost constraints remain open.

A host/global preference store would survive archive replacement but introduce
another persistence lifecycle and host coupling. Canonical preferences would
incorrectly export/sync device interaction choices. A generic JSON key/value API
would bypass version validation and bounds. The typed worker-local path reuses
existing ownership, fencing and backup boundaries.

## Alias implementation review — 2026-09-10

Store a separate version-1 registry with a revision, at most 32 aliases and at
most 16 KiB of JSON. Each alias has a stable UUID, a unique trimmed name (64
characters), a primary connection/model, at most eight distinct ordered fallback
targets, the existing tool/image/context/estimated-input-cost constraints and
the privacy-change allowance. Core owns this closed contract; unknown versions,
fields, invalid requirements and oversized registries are refused, not truncated.
Conditional put/remove operations reject stale registry revisions. Failed/lost
replies require a reload before further edits; no automatic write replay.

Preferences provides create/edit/delete and target ordering. The composer offers
an explicit review of a chosen alias's complete displayed snapshot before Apply.
Applying commits one canonical SetRoutingProfile containing the primary, all
fallbacks, requirements, privacy allowance, name and source alias/revision. It
does not reread a newer registry entry while applying: the approved displayed
snapshot is the value being saved, even if another view subsequently edits the
registry. Normal thread-revision checks and pending-mutation recovery apply.
Alias deletion affects the registry only. There is no live alias pointer in the
conversation's routing behavior.

A version-3 routing-profile payload records the primary; existing version-1
fallback and version-2 profile payloads retain their former behavior. No SQL
schema changes are needed for the existing JSON field. Manual primary/profile
edits save through the same canonical mutation and detach alias attribution.
A missing saved primary/model is shown by id and does not silently select the
first configured provider. Unsupported saved routing versions must refuse
sending until deliberately replaced. Applying a preset clears prior switch
review and prompt counts; the normal compatibility report still gates sending.
UI review of the preset configures routing, and does not itself send a prompt.

No new dependency or external provider API is introduced. Region constraints
and enforcement of request-cost limits before counting remain separate open
requirements; label the existing cost field as estimated input cost.

## Evidence required

Pinned SQLite tests: absent defaults, invalid/future rows, conditional writes,
stale writers, reopened rows, rollback and no canonical sync effects. Controller
tests: failed/lost write replies, read recovery and bounded concurrent calls.
Chromium and WebKit: real UI saves, multiline input, composition/repeat guards,
both send modes, a second client observing/conflicting, and process restart.
Record evidence in the shared-app validation report; do not close the broader
appearance, aliases or accessibility tasks with this single preference.

Implemented and verified: [local preference acceptance](../validation/local-preferences.md),
including 31 shared-app checks per engine, SQL cleanup/export exclusion and
controller failure recovery. The broader tasks above remain open.

Alias implementation verified in [routing alias acceptance](../validation/routing-aliases.md);
this closes the shared registry/application slice, not the remaining plan 10 gates.

## Complete interaction preferences — 2026-09-10

The current local preference row is version 2. It adds four closed fields to the
existing revision and send key:

| Field | Default | Alternative |
| --- | --- | --- |
| `showTimestamps` | `false` | Show message timestamps |
| `showModelBadges` | `true` | Hide message provider/model badges |
| `composerLayout` | `comfortable` | `compact` |
| `modelSwitcherStyle` | `select` | `list` |

A closed version-1 row is normalized on read with these defaults, preserving
its revision and send key without rewriting the row. The next explicit edit
writes version 2. Unknown fields, invalid scalar values and future versions
remain explicit refusals with the stored row preserved. The typed
`setInteractionPreferences` operation writes all four choices using the expected
revision and preserves the current send key; `setSendKey` preserves the four
interaction choices. Both use the existing conditional SQL write and retain the
same stale-view and lost-reply recovery behavior.

The archive protocol remains version 4: the envelope and canonical schema are
unchanged. An old strict preference reader refuses the expanded row/result;
it cannot silently drop the new fields. An old worker refuses an unknown
operation. Mixed builds must reload to obtain matching preference support;
they do not receive a fallback that rewrites the new settings as version 1.

Timestamps use message creation time, or a visibly labelled recorded time when
creation time is absent. Unrepresentable dates say that the time is unavailable.
Badge visibility affects message provider/model labels only: generation status,
usage, compatibility warnings and source records remain available. Missing
provider/model metadata is labelled unknown when badges are shown.

The comfortable composer retains two option columns and four textarea rows.
Compact uses three option columns and two rows with smaller spacing; both stack
to one column in narrow windows and keep every control and warning. Model-list
style uses native radio controls with keyboard behavior, the same reviewed
catalog models and the same primary-selection callback as the dropdown. A
missing selected model remains visible as unavailable rather than silently
selecting a different model.

These fields are independent of future theme selection and remain local,
excluded from portable/open exports and clean rescue copies. A separate host
store, arbitrary CSS preferences and a generic key/value write API would break
the existing ownership or validation contract and are not introduced.
Qualification is recorded in [interaction preferences](../validation/interaction-preferences.md).
