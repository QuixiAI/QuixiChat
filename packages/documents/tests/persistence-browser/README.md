# Real PDF.js → managed archive acceptance

From the repository root:

```sh
npx tsc --noEmit -p packages/documents/tests/persistence-browser/tsconfig.json
node packages/documents/tests/persistence-browser/run.mjs
```

The shared `QUIXI_TEST_BROWSERS` selector applies. The runner verifies the pinned
PDF.js distribution, bundles its local assets/licenses and uses a fresh OS-assigned
origin with empty initial OPFS. That origin remains fixed across deliberate browser
process restart. It neither clears unexpected archives nor fetches remote assets.
The [retained evidence](browser-evidence.json) records the actual browser/platform,
source hashes and a bounded original navigation-reference/map sample.

This proof calls the public `persistPdfDocument` export with a real production
managed StorageClient. Actual PDF.js workers parse the checked-in redistributable
[100-page PDF](../fixtures/pages-100.pdf) and [one-page PDF](../fixtures/pages-1.pdf).
Their original bytes are uploaded through public blob transfers and canonical
Document/Attachment registration. No parser output, storage result, source range,
extraction map or FTS result is substituted.

Seven groups in each browser cover:

- Page 1 of the actual 100-page PDF is published and searchable before the document
  completes. The persisted reference binds the original attachment digest, run,
  page and extraction digest. Source-map spans retain page-local UTF-16 offsets,
  original PDF item indices and six-element transforms. These are not PDF byte
  offsets.
- Awaiting the real `onProgress` callback after page 1's indexing credit pauses
  downstream work. A competing producer tab is refused before starting parser
  workers, while canonical chat commit/read remains usable.
- Cancellation terminates the two extraction/parser workers and durably interrupts
  the run while preserving page 1, its source and canonical/sync state.
- Resume starts the actual parser at page 2, observed without changing its worker
  messages. It preserves page 1's exact publication reference/maps and completes
  all 100 pages, including persisted page 100 text. No committed page is re-extracted.
- A separate one-page PDF completes after the prior source/worker resources are
  released.
- During that small PDF, the fixture drops one genuinely successful `stagePageText`
  reply. The workflow performs one automatic receipt lookup, checks the original
  digest and completes with the original operation ID and one stage dispatch.
  Public extraction/global receipts agree; canonical counts and source bytes stay
  unchanged. The worker shim only observes calls or suppresses the real reply.
- A full browser-process restart preserves completed extraction/search, original
  PDF bytes, exact page 1 identity and the concurrently written chat.

Fixture setup caps complete PDF loading at 128 KiB and uploads at most 64 KiB per
chunk. Production extraction uses its real verified OPFS range source and bounded
page staging. Progress recording stores only the latest state, at most twelve
observed parser start pages and a bounded map sample; it does not retain the
100-page document text or source maps in the test realm. This is a behavior proof,
not a new peak-memory, native-WebView, OCR or hostile-document qualification.
