# Build tooling

Shared Vite configuration keeps browser and desktop frontend builds aligned.
Development and preview servers send COOP/COEP headers to establish a consistent
starting point for the A1 storage proof. Docker hosting sends the same headers.
Tauri custom-protocol behavior must still be validated on each target WebView.

Root npm scripts orchestrate builds. Put future artifact verification, SQLite and
embedding artifact integration, and release scripts here. Runtime code belongs
in its owning package; compiler implementation belongs with QuixiEmbed.

Browser runners share `browser-engines.mjs`. With no `QUIXI_TEST_BROWSERS`, they
run Chromium and WebKit. Set it to `chromium`, `webkit`, or `chromium,webkit` to
choose explicitly; empty, unknown and duplicate selections fail before setup.
For example: `QUIXI_TEST_BROWSERS=webkit npm run test:app:browser`.
Embedding runners keep their separate explicit engine/backend CLI.

The CI frontend matrix runs unit checks and Chromium on Ubuntu 24.04, and WebKit
on macOS 26. Each job retains its own browser reports. This configuration is not
evidence that a remote run passed; see the recorded package/validation reports
for actual exercised hosts. Playwright WebKit and Tauri's platform WebView are
separate qualification targets.
