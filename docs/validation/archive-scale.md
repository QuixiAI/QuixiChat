# Archives at scale: 30,000 messages exported, restored and read with ordinary tools

Date: 2026-09-12. Plan: [09](../plans/09_add_archives_and_open_export.md).
Decision context: [ADR 0010](../decisions/0010-portable-archives.md).
Retained record: [archive-scale-browser.json](../../packages/app/tests/browser/results/archive-scale-browser.json).

```sh
npm run test:app:archive-scale:browser                                    # default 300 × 100 = 30,000 messages
QUIXI_ARCHIVE_SCALE_THREADS=20 QUIXI_ARCHIVE_SCALE_PER_THREAD=10 npm run test:app:archive-scale:browser
```

## What the proof does

The application harness page (`?embedding=missing`: no model, no Cloud
account) seeds threads and messages through the Storage Worker, runs the
production lexical indexer so derived data is present as in a used archive,
then drives the production archive operations: `beginArchiveExport` and
bounded `advanceArchiveJob` steps (≤ 128 records, ≤ 1 MiB each) for the
portable and the open format, `openArchiveExport` and the chunked read
whose digest must match the job's, and `beginArchiveRestore` /
`finishArchiveRestore` / bounded validation of the portable bytes into an
isolated candidate that is released, never activated. A copy of the
container with 64 KiB zeroed in the middle is then offered for restore. The
open export's container is pulled out of the page and, in Node, listed and
extracted with the system `tar`, its JSONL parsed line by line with
`JSON.parse`, and its Markdown read as text.

## Result

| 30,000 messages (300 threads × 100) | Chromium | WebKit |
| --- | --- | --- |
| archive on OPFS before export (with the lexical index) | 420 MB | 452 MB |
| portable export: bytes / time / bounded steps | 106.1 MB / 430 s / 1537 | 106.2 MB / 85 s / 1537 |
| portable export read out (streamed chunks, digest verified) | 1698 chunks, 0.2 s | 1700 chunks, 0.2 s |
| isolated restore of those bytes: validation steps / time / records | 2713 / 178 s / 60900 at schema 12 | 2713 / 133 s / 60900 at schema 12 |
| corrupted container (64 KiB zeroed) | refused: IO_ERROR; active archive integrity ok, exact search answers | refused: IO_ERROR; active archive integrity ok, exact search answers |
| open export: bytes / time / bounded steps | 64.8 MB / 399 s / 2209 | 64.8 MB / 87 s / 2209 |
| system `tar -tf` entries; JSONL records parsed; invalid lines | 5; 91503 (30000 messages, 300 threads); 0 | 5; 91503 (30000 messages, 300 threads); 0 |
| Markdown passages readable as text | 30000 of 30,000 | 30000 of 30,000 |

Every phase ran with the step bounds above; no page errors in either engine.
The portable export is slower in Chromium (its OPFS commit per step costs
about ten times WebKit's, the same floor ADR 0038 records for indexing); it
stays bounded and streams. Restoring the 106 MB container validated
60,900 canonical records in 2713 steps without touching the active
archive, and the corrupted copy was refused at the checksum claim with the
cause reported and the active archive still answering searches.

## Capacity check

Since the run above, every export and restore begins with the storage-capacity
check of ADR 0010's amendment; the small smoke run and the archive snapshot
proof exercise the positive path with the browser's real estimate, and
`capacity.test.ts` covers the refusal arithmetic and the unknown-estimate
rule.

## Limits

Single runs under development load on one machine; synthetic short
single-part messages without attachments (blob validation had nothing to
verify); Playwright engines rather than shipped browsers; the cross-host
restore (another supported host) remains a native gate.
