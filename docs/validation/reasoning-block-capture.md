# Complete thinking-block capture

This plan-06 prerequisite preserves complete Anthropic thinking and redacted
blocks as verified, directly referenced raw blobs. It does not enable reasoning
continuation or a thinking-generation control. [ADR 0031](../decisions/0031-complete-thinking-block-capture.md)
records the reviewed contract, limits and remaining dispatch requirements.

## Behavior and verification

Exact text and split signatures assemble only through matching block closure.
Empty displayed thinking retains its signature; encrypted redacted data remains
opaque. Original raw SSE segments and existing reasoning markers remain intact.
The versioned receipt names its generation, response, provider index and source
record range. Blob registration and the canonical reference commit atomically.

The 86 provider tests include seven new normalization groups and two new
persistence groups: fragmented Unicode/whitespace and signatures, empty display,
redacted payloads, interruption before closure, malformed/unknown fields, ordering,
duplicate indexes, escaped-byte and aggregate limits, atomic reference publication,
lost replies, and consumer refusal of unsupported protocol or missing evidence.
A boundary-error assertion initially exposed a generic serialization error for
oversized receipts; the consumer now reports the thinking-receipt limit explicitly.
The fixture's typed storage results were also corrected before browser execution.

Qualification passes: **28 provider browser checks per engine**, **19 native
Tauri checks**, **63 full application groups per engine**, **86 provider tests**
and `npm run check`. Browser coverage uses actual
HTTP, SQLite/WASM/OPFS, a suppressed receipt-commit reply, verified blob reads,
reopen and full browser restart. The portable round trip uses production archive
jobs and independent query-only inspection of the isolated restore candidate;
it does not claim shared-UI activation or archived continuation.

## Limits and next step

The fixture values are synthetic. These checks establish preservation and host
transport, not signature validity, live provider acceptance, reasoning quality
or billing. Unknown block fields currently fail capture explicitly. Bounds may
refuse a large otherwise-valid response; its preceding raw checkpoints remain.
No model download, paid call, external deployment or private history is involved.

Request mapping, verified provenance loading, capability-driven thinking parameters,
compatibility/count/send/regenerate agreement and archived continuation remain
open. The roadmap's next slice must finish that path before claiming reasoning
continuation is implemented.

## Retained evidence

The [aggregate record](results/reasoning-block-capture-checks-macos.json) verifies
140 final source hashes against the worktree and hashes 10 retained evidence
artifacts, including reports and logs.
The application and native proofs also checked source stability during their runs.
Evidence includes the [application regression](results/reasoning-block-capture-app-macos.json),
[browser transport, persistence and archives](results/reasoning-block-capture-providers-browser-macos.json),
and [actual macOS native transport](results/reasoning-block-capture-providers-native-macos.json).
Both browser engines transfer archives in chunks of at most 65,536 bytes. Native
qualification includes successful disposable-keychain cleanup on macOS 26.6.2.
