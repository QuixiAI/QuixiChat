# Reusable routing alias acceptance

2026-09-10, macOS 26.6.2 arm64, Node 22.23.1. This implements product sections
33–34 and the alias portion of plan 10, following
[ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md#alias-implementation-review--2026-09-10).

## Implemented behavior

The shared Preferences screen creates, edits, reorders and deletes named routing
aliases. Each stores a primary connection/model, up to eight ordered fallback
targets, tool/image/context/estimated-input-cost requirements and the allowance
for changing the privacy class. Missing targets remain visible by id. Deletion
requires an explicit confirmation. The editor preserves its original registry
revision through refreshes, so a stale save cannot overwrite another edit.

[Core contracts](../../packages/core/src/contracts/routing-aliases.ts) define a
closed, versioned registry capped at 32 aliases and 16 KiB of serialized JSON.
Unknown fields/versions, duplicate names/ids/targets, malformed constraints and
oversized registries are refused. The [worker repository](../../packages/storage/src/worker/routing-aliases.ts)
uses a separate row in the existing local-state table, a conditional revision
write, and the ordinary active-selection fence and bounded worker queue. No
SQLite migration, host storage path or new dependency is introduced.

The composer displays the complete selected alias snapshot and requires a review
before applying it. One canonical `SetRoutingProfile` mutation saves the name,
primary, fallbacks, constraints, privacy allowance and alias source revision
with its sync operation. It applies the displayed snapshot without rereading a
possibly newer alias; later registry edits/deletion never change that copy.
Applying preserves the unsent draft and sends no provider request. The normal
provider-switch compatibility review remains required before a consequential
send. Prior review and token counts are cleared on routing changes, and sending
waits until the canonical change and refreshed view have settled.

Version-3 routing payloads persist a primary; versions 1 and 2 retain their
existing behavior. A missing saved primary is not replaced by another configured
provider. The user can deliberately choose a replacement, which persists and
detaches alias attribution. Unsupported saved routing versions refuse sending
until explicitly replaced/reset. Applied profiles are canonical and exportable;
the device-local reusable registry is omitted from portable exports and cleaned
rescue restores. Raw byte rescue remains an exact copy of the source database.

## Validation

The [retained regression report](results/routing-aliases-unit-macos.json) includes
full output and source hashes:

- `npm run test:core`: **51 passed**, including closed shapes, size/count/name
  bounds, target/constraint refusals and deep-copy snapshot independence.
- `npm run test:storage:canonical`: **40 passed**. Alias checks cover SQLite
  close/reopen, conditional CRUD, stale revisions, invalid stored data preserved,
  rollback, independent interaction preferences, and no registry sync effects.
  A forced failure immediately before canonical commit leaves neither the
  applied profile nor its sync operation; success saves both, replay is safe,
  and later alias edits/deletion leave the canonical copy unchanged.
- `npm run test:app:preferences`: **7 passed**, including lost alias-save reply
  recovery through a read, no automatic write replay, one pending request, and
  preservation of the editor's original revision.
- `npm run test:app:switching`: **21 passed**, including version-1/2 compatibility,
  version-3 primary/source round-trip, and unsupported routing refusal.
- Archive typecheck and `node --experimental-transform-types --test
  packages/storage/tests/archives/sqlite-file.test.ts`: **10 passed**. The
  clean-copy proof now omits reusable aliases while leaving the source intact.

`npm run test:app:browser`: **32 checks per Chromium and WebKit**, retained in the
[shared application report](results/shared-app-macos-26.6.2.json). The alias
scenario drives real shared UI → production worker/OPFS → host/provider adapters
with synthetic loopback HTTP. It exercises CRUD, unavailable-target reorder,
lost durable-save reply and reload recovery, stale edit refusal, explicit
snapshot review, unchanged draft/no request during apply, exactly one canonical
sync operation, a fresh compatibility review and an actual routed request.
It also applies a missing primary while other providers are configured, proves
no implicit replacement/keyboard send, persists a deliberate primary change,
and reapplies the original alias as a new reviewed copy. Editing/deleting the
alias leaves the copied conversation unchanged. A fresh browser process retains
the registry and canonical copy and shows unavailable credentials/targets by id.
Desktop-width and narrow screenshots were visually inspected.

`npm run check` passed: SQLite verification, typecheck and both host frontend
builds. The existing large-bundle warning remains. One initial browser run used
the wrong test selector for the route summary; correcting it preserved the
assertion. Routing controls also remain disabled until their saved view finishes
refreshing, preventing an input from being silently ignored during that interval.

## Remaining gates

Plan 10 still needs region metadata/constraints, cost enforcement before a prompt
has been counted, context compaction and its reload/inspection acceptance. The
cost field describes the implemented estimated **input** cost, not a complete
request-cost guarantee. Native desktop, installed Safari and other OS behavior
remain release qualification; a frontend build or Playwright WebKit is not that
proof. The other interaction preferences and themes remain plan 13 work. No
Cloud, OCR, paid provider, deployment, publication or private dataset was used.

## Compaction regression refresh — 2026-09-10

The retained unit report was refreshed against the final attachment-compaction
sources: 52 core, 42 storage, 7 preference/controller, 21 switching, 9 attachment
and 13 archive Node tests pass (144 total), plus `npm run check`. The shared app
report now has 33 passing groups in each browser, including the existing
preference/alias checks. Earlier counts above describe the original feature slice.
[Compaction acceptance](context-compaction.md) records schema 11/protocol 3,
portable restore and remaining gates; summary and explicit branch choices stay open.
