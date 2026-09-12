# Bundled native PDF qualification

Run on macOS 14 or newer with the repository's pinned Node, Rust, SQLite WASM,
and PDF.js dependencies already provisioned:

```sh
python3 tests/hosts/document-proof/run.py
```

The runner builds a separate `quixi-document-proof` binary with the additive
`document-proof,custom-protocol` features. Ordinary desktop commands continue to
select `quixi-desktop`. The synthetic frontend uses actual public storage and
document APIs, the real storage/PDF workers, and the production CSP unchanged.
It does not use the normal desktop frontend or modify its built assets.

Every invocation generates a new UUID passed to Tauri's
`WebviewWindowBuilder::data_store_identifier`. The pinned Tauri 2.11.5 API uses
this identifier for an isolated WKWebsiteDataStore on macOS 14+. The runner
rejects older/non-macOS hosts before launching. The binary requires the explicit
UUID and a write/restart/cleanup phase, and uses the distinct app identifier
`ai.quixi.chat.document-proof`. Its public managed default archive and selection
catalog therefore exist only inside this synthetic profile. The second process
must see the first process's UUID marker and published records. Cleanup removes
only the two synthetic OPFS archive/catalog directories and fixture metadata
inside that same profile; it does not delete production data or global WebKit
folders. WebKit may retain cache/profile bookkeeping for the synthetic UUID.

The write phase verifies real one-page extraction, publication of page one to
FTS before cancellation, worker termination, resumption of a 100-page document
at page two, completion, malformed/encrypted error codes, and all six original
SHA-256 values through bounded public blob reads. Two additional authored layout
PDFs verify persisted page-two column/paragraph order, a real FTS hit resolving
to that exact layout2 publication, and explicit rotated-page fallback metadata,
including a one-character read. A fresh native process checks these layouts,
completed checkpoints, actual extracted page text and original bytes. The runner
compares both layout publication identities, text hashes and metadata before
and after process restart. Fixture
acquisition alone uses a proof-only buffer capped at 128 KiB; production parsing
reads immutable stored originals through the real bounded range source.

`evidence/native-pdf.json` records phase results, platform/WebKit version, actual
worker and bundled resource URLs, observed font responses, configured/effective
CSP, source and binary hashes, and the full built-asset inventory. Supplemental
font/CMap assets and SQLite WASM must match the pinned packages. Earlier reports
are retained in `evidence/attempts/` before a rerun; a failed run cannot leave a
stale passed report. `--skip-build` requires the exact recorded binary/source
snapshot. Each native phase has a 240-second watchdog plus an outer deadline.
The watchdog includes the last awaited frontend checkpoint and observed bundled
requests, so a timeout identifies how far the workflow progressed. The synthetic
window is visible while running, matching the ordinary native host lifecycle.

This is native WKWebView functional qualification, not a release benchmark.
Other native WebView families, release packaging/signing and larger documents
remain separate gates. Functional timings can reflect development load.
