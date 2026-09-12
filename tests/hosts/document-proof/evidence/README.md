# Recorded native PDF qualification

`native-pdf.json` passed on 2026-09-09 at 10:56:56 UTC. All 40 recorded source
hashes were unchanged during capture and matched the workspace on review.
The binary was the feature-gated development build with bundled custom-protocol
assets on macOS 26.6.2, system WebKit `21624.5.1.11.3`.

The actual native WKWebView passed:

- Public managed storage creation inside a fresh explicit UUID datastore,
  with zero initial canonical records.
- Real bundled PDF.js extraction and publication of one page.
- Real FTS visibility of page one before cancellation; interrupted durable
  checkpoint and termination of both PDF workers.
- Resumption of the 100-page document at page two, completion and page-100 text.
- `PARSE_FAILED` for malformed input and `PASSWORD_REQUIRED` for encrypted input.
- Actual `quixi-layout-2` production normalization with derived extraction schema
  2: authored page-two heading/left paragraphs/right paragraphs/footer order,
  explicit geometric column metadata, and a real FTS hit resolving to the exact
  current page-two publication.
- Preserved horizontal/rotated text anchors and explicit `source_order` /
  `rotated_or_skewed` metadata, including a one-character page read.
- Exact SHA-256 preservation of all six stored originals, including failed PDFs.
- A separate native process reading completed checkpoints, extracted text and
  unchanged original bytes from the same UUID datastore.
- Synthetic OPFS/catalog cleanup in a third native process.

The write phase passed 19 checks, restart passed 13, and cleanup passed one.
The runner also compared both layout publication IDs, text hashes, normalizer
versions and layout metadata across processes: `layoutRestartExact` is true.
This replay includes awaited `pdf.cleanup()` between drained pages, exercising
the parser's shared-font-cache release through the actual native workflow. It
establishes functional compatibility; heap/peak-memory measurements remain in
the separate memory harness. The worker source SHA-256 is
`c7eefd342957a2ebf73005d94af82ff18bb35d8f17c1afe0723b29238a257dd5`.
The current replay also exercises the combined synchronous search-page
validation cache and exact canonical extraction-argument serialization reuse.
The extraction repository source captured by the runner is
`e0175db4d0a20b182d7c31bda46e95dd5eb15e82c60e67cf09ad6c4d5779b92d`.
The unchanged runner records the bundled archive worker containing search code,
but does not independently fingerprint `search/index.ts`. Its separately checked
post-capture source hash (10:57:19 UTC) is
`c65bdb72396fe09bbb00067a9cd524bbbdf18bf394929db20b7e457c385e98ac`;
that supplementary check is not part of the runner's 40-file drift assertion.
This native fixture opens a fresh schema-2 archive; preservation of pre-upgrade
schema-1 pages/receipts is independently covered by the storage migration tests.

The unchanged production CSP was recorded both as configured text and as the
actual HTML response header with Tauri's injected script hashes. Actual worker
URLs use `tauri://localhost/assets/`. Real requests for bundled Liberation Sans
and Foxit Fixed returned HTTP 200. All 182 font/CMap assets match the pinned
PDF.js package; the bundled SQLite WASM matches its pinned artifact. No
main-document CSP violations were observed. No CSP relaxation was needed.

The archived first attempt, `attempts/20260909T091149Z-466394e9.json`, reached
the write watchdog with its sole window hidden; same-profile cleanup succeeded.
The final proof uses a visible window and adds checkpoint diagnostics. The
subsequent success does not isolate the precise cause of the earlier stall.
The archived failure is retained rather than counted as passing evidence. The
earlier successful pre-layout2 qualification is also retained unchanged as
`attempts/20260909T094731Z-2bedc298.json`.
The layout2/schema2 pass before the shared-cache cleanup change is retained as
`attempts/20260909T102227Z-844f8e44.json`.
The page-cleanup-only native replay is retained as
`attempts/20260909T105636Z-b06b540e.json`.

This is functional evidence under concurrent development activity, not a
controlled performance result. It does not qualify release signing/packaging,
other native WebView families or large-document memory behavior. The datastore
UUID isolates user data, but WebKit can retain synthetic profile/cache
bookkeeping after the fixture removes its own OPFS directories.

Report SHA-256:
`c9ce8d3426a4a32ba9173b89008cd2fe4d09c8551fc9394fa448d356828a57ce`.
