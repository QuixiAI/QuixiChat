# Provider import validation

The implemented profiles and unresolved format-qualification requirements are described in the [package README](../README.md) and [fixture provenance](../tests/fixtures/README.md).

## Pure parser and actual SQLite WASM acceptance

`node --experimental-transform-types --test packages/importers/tests/*.test.ts` passed 20 tests on 2026-09-08. A subsequently added image-pointer/invalid-Unicode regression passed independently, bringing the covered set to 21 tests. The complete run took approximately 35 seconds; its 2,000-message reverse-order source took approximately 28 seconds. This is a bounded-memory acceptance case, not a claim that all large archival shapes meet a latency target.

Coverage includes SAX parsing across byte boundaries, large strings, UTF-8/escape handling, malformed source and bounds; exact raw-byte preservation; arbitrary parent order and branches; many-part sealed messages; blob-backed text; native and heuristic source identities; repeat-import deduplication; immutable edits and preserved local state; unsupported parts; missing and subsequently resolved attachment bytes; ZIP/ZIP64/stored/deflate/CRC/size checks; source-scoped NDJSON reports; pause, owner repository restart and retained-source resume; lost allocation/staging/publication/work acknowledgments; typed image pointers, retained invalid Unicode and visible metadata truncation.

The storage test adapter uses the **actual pinned SQLite WASM artifact with MEMFS**, checked against the artifact SHA256. Its byte layer and transport are explicit in-memory test doubles. These tests do not establish OPFS or browser-process persistence. Test-only fixtures may be materialized in memory for assertions; the importer and synthetic large-source generator stream records and ranges.

## Production browser acceptance

`node --experimental-transform-types packages/importers/tests/browser/run.mjs` uses the production `ArchiveStorageClient`, real worker, official SQLite WASM OO API and OPFS SAH-pool backend in disposable Chromium/WebKit persistent profiles. It serves only a local synthetic test page on port 4193 and removes its temporary profiles after completion. The machine-readable report is `test-results/provider-import-browser.json` and includes source hashes and host user agents.

Current status: **passed in Chromium and WebKit**, including actual owner-tab termination and browser-process restart. The [recorded report](./browser-evidence.json) includes source hashes and host details. Owner-handoff diagnostic polling retries only `UNKNOWN_OUTCOME` reads; mutating import identities are unchanged.

Passed coverage: a follower imports original ZIP64 and numbered JSON with over 1,000 parts, long UTF-8 text and an exact-path asset; Claude normalization uses the same production boundary; a separate per-run Web Lock rejects competing execution; staged threads remain invisible; abrupt owner-tab termination permits retained-source resume; report export includes scoped warnings; an actual browser-process restart retains canonical history and verifies every original-source digest and long-text blob.

## Shared React workflow acceptance

`node --experimental-transform-types packages/app/src/features/imports/tests/browser/run.mjs` passed thirteen check groups in Chromium and WebKit on 2026-09-09. The three newest groups import the same export again for the same account without new threads, messages or parts; import an edited copy that adds sealed revisions in the same thread while keeping the original message and raw source; and find imported text by exact lexical search with no provider account or semantic index; a fourth imports an export whose user record carries an unsupported author role and shows the malformed-record notice while the rest of the export imports. The [recorded UI report](./import-panel-browser-evidence.json) captures source hashes and host versions. This harness mounts the exported shared React feature in StrictMode with the production browser HostClient, ArchiveStorageClient, worker and OPFS backend. It verifies real file selection and handle release, completed imports, scoped warnings, canonical thread navigation callbacks, verified report download through a separate save gesture, pause during an actual storage acknowledgment, actual browser-process restart and retained-source resume, explicit discard, and active component unmount. Discard and unmount leave partial threads hidden; saved conversations and original files remain available.

`node --experimental-transform-types packages/app/src/features/imports/tests/discard.test.mjs` also passed three actual pinned SQLite WASM tests. They cover hidden-work cleanup, preservation after a lost successful publication reply, global operation-identity conflict before cleanup, and resumption after a lost cleanup acknowledgment and repository restart. Byte transport in those Node tests remains an explicit test double.

The shared feature is ready for composition. This feature harness does not establish the final application navigation or desktop import UX.

## Open qualification

No QuixiChat test yet uses a captured, current official ChatGPT or Claude consumer export. Primary maintainer observations and original synthetic shapes are clearly labeled. Provider-format compatibility, richer asset sidecars, changed published-asset reconciliation, final shared application composition and host-specific release qualification remain explicit plan 04 work. Search and inference are not prerequisites for retained canonical content.
