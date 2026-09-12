# Shared document UI acceptance

Run from the repository root:

```sh
npm run test:app:documents
npm run test:app:documents:browser
npm run test:documents:mutation
npm run test:documents:clear
npm run test:storage:search-navigation
```

The [browser report](results/document-ui-browser.json) records selected engines,
platform, source hashes and each completed check. The runner builds the actual web
entry point and shared application, uses an isolated ephemeral origin and a fresh
persistent browser profile, and imports synthetic PDFs through the production host
file picker. SQLite WASM/OPFS, canonical document/blob publication, PDF.js workers,
extraction persistence and shared FTS are real. No provider is configured or called.

The current retained browser run passes sixteen check groups in each of Chromium
and WebKit. The controlled app suite passes 38 tests (23 controller and 15 import),
the uncertain extraction mutation helper has 11 additional tests, and the clear
helper has eight controlled tests.

For deterministic early-search/cancellation coverage, the test holds one real
page-one index-credit reply after the worker has processed it. Search results can
then open that exact published page while extraction is still waiting. Stop is
clicked before releasing the reply; the test verifies that page two was not
published. It resumes the same document, completes 100 pages and opens page 42.
The remaining checks cover original SHA-256 equality, concurrent conversation
creation and an unsent draft, highlighted text, full browser restart, stale results
after extraction is cleared, and encrypted/malformed/scanned outcomes. A scanned page with a one-character
footer preserves both its extracted text and stored low-text classification through
full browser restart.

Failed extraction now displays its stored interruption reason independently of the
transient alert, including after opening another document or restarting the browser.
Password, parser, capacity and unavailable-source failures offer retry/import-copy
guidance; stopped work and confirmed producer loss retain Resume. No password entry
or automatic retry is introduced.

Actual encrypted, malformed, 1,001-page and over-budget text-page cases each verify
the durable reason across a full browser restart, unchanged run/writer identity on
reopen, explicit retry of that run, refusal to open an unpublished page, reviewed
clear and exact original SHA-256 before and after recovery. The later successful
scanned/layout imports demonstrate that failures do not prevent further document work.
A real file-picker selection of a 32 MiB + 1 byte file is rejected before canonical
document creation; a supported import then succeeds. This is explicit outcome and
recovery acceptance, not a worst-case parser memory bound. Previous browser reports
are retained under `results/attempts/`; recovery screenshots accompany the current report.

The recovery controls capture the run and document revision shown at review.
Cancelling confirmation preserves that extraction; confirming removes its saved
text and search publication while the original PDF's SHA-256 remains identical.
The old search snapshot refuses navigation. Explicit extraction starts a different
run at page one and publishes searchable text with normal cancellation/resume.
Controller tests additionally fence stale reviews and archive changes, keep reads
from repainting old text during clear or while its outcome remains pending, drain
cancellation, and reconcile an uncertain clear with its original operation ID and
digest. Replay reacquires producer exclusion and honors Stop before dispatch;
another producer retains the pending operation without a replay. Helper tests verify
producer exclusion and borrowed-client lifetime through receipt/cleanup failures.

Interleaved columns open the exact second page from an FTS hit and preserve
complete left-before-right reading order. Table cells retain their row association
and code retains indentation in durable page reads. A rotated-layout PDF remains
searchable with its stored source-order warning after a full browser restart.
The [independent layout proof](../../../../../../documents/tests/layout-browser/README.md)
additionally compares every emitted source span and transform with raw PDF.js.
The UI runner checks source hashes again at completion and refuses a passing
capture if an input changed during the run.

The controlled controller/import tests cover asynchronous view races, exact
operation retention, page-window bounds and recovery outcomes. The separate
[resolver acceptance](../../../../../../storage/tests/search-navigation/README.md)
checks current source identity without loading page text/maps. The
[PDF persistence proof](../../../../../../documents/tests/persistence-browser/README.md)
qualifies real producer cancellation, owner lifetime and dropped-reply recovery.
After a selection change, recovery uses the old archive's exact operation
identities and waits for admitted document reads before closing the stale client.
The [retained receipt proof](../../../../../../storage/tests/retained-extraction/README.md)
separately exercises the real public activation and read-only recovery path;
controller tests cover the callback coordination. The UI browser scenarios above
do not claim to simulate every lost-reply/activation interleaving.

This UI displays at most 16,384 UTF-16 units of **extracted page text** with the
original page number and exact source identity. It does not visually render the PDF.
An empty page explains that it may contain scanned images; OCR is deferred.
Semantic search is explicitly unavailable until its separate integration is done.
Completed storage pages are not automatically presented as completed lexical
indexing: the availability count comes from acknowledged page-index progress.

Browser results do not qualify native Tauri file dialogs/CSP, every international
font/layout, near-limit parser memory, full accessibility or release-scale behavior.
Source input remains capped at 32 MiB. The first 100-page fixture is a correctness
case, not a memory or throughput benchmark. Screenshots are retained alongside the
report for visual inspection; failed runs retain their last visible text.
