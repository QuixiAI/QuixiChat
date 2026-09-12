# Reasoning continuation and manual thinking

This plan-06 slice completes the request side of thinking: the reviewed Haiku
4.5 manual-thinking parameter and provenance-bound continuation of complete
signed and redacted blocks from the receipts [ADR 0031](../decisions/0031-complete-thinking-block-capture.md)
captures. [ADR 0032](../decisions/0032-reasoning-continuation.md) records the
reviewed contract (fetched 2026-09-11), the binding rules and the shaping policy.

## Behavior and verification

The Anthropic catalog entry declares the `anthropic-manual-haiku-4.5` profile
and permits `thinkingBudgetTokens`. The mapper emits `thinking.enabled` only
under that profile and refuses by name a budget below 1,024 or at or above the
output limit, a set temperature, and a top-p outside 0.95–1; the count endpoint
receives the same configuration. The composer shows the control for that model
only, explains each constraint, blocks sending and keeps the draft.

A ReasoningMetadata marker becomes request content only through a verified
entry: receipts read through the storage boundary, parsed against the version-1
contract and bound to the message's generation, output message, response,
model, block kinds, ascending indexes and exact opening stream records. A
message without valid receipts is reconstructed from its retained raw segments
(8 MiB bound) through the live decoder and normalizer and bound the same way.
Verified blocks are carried first and unchanged to the producing model only;
for any other target, and for markers no evidence verifies, the request omits
them and names the omission per target, which the contract permits outside a
tool-use loop; markers a tool result follows are kept for the mapper's own
refusal. Inspection, portability, count, send, regeneration and fallback share
one mapper and one shaping function.

## Evidence

- **94 provider tests** (`npm test --workspace @quixi/providers`), eight new in
  [continuation.test.ts](../../packages/providers/tests/continuation.test.ts):
  parameter mapping and every constraint, the shipped catalog profile, exact
  block carriage and order, eleven named refusals, receipt parsing, binding
  agreement and each disagreement, raw-stream reconstruction equal to the live
  normalizer and its three refusals, and count/generation bodies over actual
  HTTP carrying the same parameter and blocks. One compatibility expectation
  changed from the generic refusal to `reasoning_unsupported` for the Chat
  Completions profile.
- **85 switching unit tests** (`npm run test:app:switching`), four new in
  [reasoning-shape.test.ts](../../packages/app/tests/switching/reasoning-shape.test.ts):
  producing-model carriage, foreign/unverified omission by cause, tool-loop
  retention, marker-only turn dropping and the portability wording.
- **29 provider browser checks per engine** (`npm run test:providers:browser`,
  Chromium and WebKit): a persisted signed/redacted response is continued from
  receipts read through the public storage client, equal to a reconstruction
  from its raw segments, mapped into a thinking-enabled follow-up whose count
  and generation the loopback provider accepted under the documented shape,
  while the same branch without evidence is refused by name. The proof
  exposed that thinking and signature delta locators are evidence parts too;
  `isReasoningEvidencePart` now covers them.
- **65 shared-application groups per engine** (`npm run test:app:browser`):
  the composer refuses each thinking constraint without writes or HTTP; a
  thinking-enabled send carries the budget and records receipts beside their
  markers; count, a later send and regeneration carry the blocks first and
  unchanged; the OpenAI switch report and portability name the omitted blocks
  and its request carries none; returning to Anthropic restores them with the
  response's records unchanged; after a fresh browser process the receipts
  still verify and a follow-up carries the same blocks. The seeded portability
  thread's unverified marker is now portable with the omission named per
  target instead of blocked.
- **19 native Tauri checks** (`npm run test:native --workspace @quixi/providers`),
  re-run because shared fixtures changed; the native proof exercises host
  transport, not the continuation path.
- `npm run check` passes.

## Limits

The fixtures are synthetic. The loopback provider enforces the documented
request shape only: signature validity, live acceptance of continued blocks,
thinking quality and billing are not established. Continuation across a
tool-use loop is mapped and unit-tested but not exercised end to end because
the shared chat does not invoke tools. Reconstruction refuses streams that end
before their terminal marker; their earlier raw checkpoints remain. No model
download, paid call, deployment or private history is involved.

## Retained evidence

The [aggregate record](results/reasoning-continuation-checks-macos.json)
verifies the listed source hashes against the worktree and hashes the retained
reports: [provider browser](results/reasoning-continuation-providers-browser-macos.json),
[application](results/reasoning-continuation-app-macos.json) and
[native](results/reasoning-continuation-providers-native-macos.json).
