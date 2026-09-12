# Cross-package tests

Reserve `integration/` for workflows spanning package boundaries, `e2e/` for
actual browser/WebView runs, and `fixtures/` for small synthetic or redistributable
archives/documents shared across packages. Keep unit tests with their owner.

A1 browser scenarios exercise real SQLite WASM and OPFS, including browser restart,
ownership conflicts, interrupted writes, browser quota failure, and FTS/vector SQL.
Run `npm run test:e2e` after provisioning SQLite and Playwright browsers. Test
sources have a separate `npm run typecheck:tests` gate. The persistent-profile
fixture is required for the measured WebKit OPFS behavior.

Use `QUIXI_TEST_BASE_URL` to run the same suite against a Docker/local server;
otherwise Playwright starts the Vite production preview. Set distinct sibling
`QUIXI_TEST_OUTPUT_DIR` paths for concurrent runs, since each run cleans its output
directory. `tooling/record-storage-evidence.py` extracts reviewable JSON evidence
from those reports while preserving skipped and failed checks.

See `hosts/` for actual bundled Tauri checks and `diagnostics/` for isolated
platform probes. A1 proof records are not canonical user history; product import,
export/restore, document, and scale acceptance tests follow their implementations.
