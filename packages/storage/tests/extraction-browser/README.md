# Public extraction persistence and search acceptance

Run from the repository root:

```sh
npx tsc --noEmit -p packages/storage/tests/extraction-browser/tsconfig.json
node packages/storage/tests/extraction-browser/run.mjs
```

The shared `QUIXI_TEST_BROWSERS` selector applies; default is Chromium and WebKit.
The runner allocates a fresh OS-assigned origin and requires empty initial OPFS,
then preserves that origin across deliberate browser-process restart. It never
clears unexpected stored archives. Reports include actual platform/browser identity
and source hashes in `test-results/extraction-client-browser.json`.

The [retained browser evidence](browser-evidence.json) passes seven groups in each
engine on macOS 26.6.2 arm64. All recorded source hashes matched at capture.

This fixture uses public `openActiveStorageClient()` and typed StorageOperations,
with actual pinned SQLite WASM, OPFS SAH-pool, managed selection, canonical records,
blob publication, extraction journal, global operation claims and shared FTS. It
uploads the exact checked-in redistributable
[100-page PDF](../../../documents/tests/fixtures/pages-100.pdf), retains its canonical
Document/Attachment, and verifies the original bytes through public blob reads.
The fixture PDF has 100 pages; the test publishes two pages of **synthetic text and
source-shaped maps** and leaves a staged third page. It does not claim those strings
were parsed from the PDF or that the remaining pages were extracted. Whole fixture
loading is explicitly capped at 128 KiB; production PDF streaming/parser admission
is a separate workflow proof.

The tests verify:

- Ten successful full-reader creation replies and ten successful range-reader
  creation replies are genuinely suppressed. Each unknown allocation is discarded
  using its known request ID. Eight fresh full-reader slots and seven child slots
  plus their parent remain available afterward, proving repeated cleanup beyond
  the eight-transfer limit. Returned read/slice IDs equal their request IDs.

- Two clients share the actual owner. Canonical Document/Attachment and original
  blob bytes remain unchanged by derived extraction operations.
- Genuine successful stage and publication replies are suppressed at the client
  boundary. Each reports `UNKNOWN_OUTCOME` with its original operation ID; global
  status and exact retry recover the committed receipt. A valid changed-payload
  retry conflicts. This is not a mocked storage result.
- Staged text is invisible. Published page 1 matches a phrase spanning staging
  fragments and preserves Unicode/NUL text with bounded source-map reads. Its
  shared chunk identity remains unchanged while page 2 is paused/staged and after
  page 2 publishes and receives page-specific indexing credit.
- Canonical, blob-control and extraction operation identities cannot be reused
  across journals. Rejected attempts preserve the original receipt and document
  title.
- Abrupt owner-tab termination retains two completed pages, the third page's exact
  staged checkpoint/receipt, and the current writer epoch. Ordinary handoff does
  not invent producer interruption.
- Full browser-process restart preserves text, maps, search, original bytes and
  global receipts. Explicit interruption/resume rotates the writer epoch and
  rejects new writes using the old epoch. Canonical/sync counts remain unchanged
  and SQLite integrity remains `ok`.

The [private repository acceptance](../extraction-search/README.md) separately
covers long pages, capacity rollback, derived corruption/repair and bounded scans.
This browser proof does not qualify PDF.js parsing, OCR, UI workflow, native WebView
or browser quota exhaustion.
