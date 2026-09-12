# Quixi Import extension (Chromium MV3)

Brings ChatGPT history into a local Quixi archive. The user starts every step
from the extension's import page (toolbar button → full tab):

1. Enter the Quixi origin, the six-digit pairing code shown under *Import
   history* on that Quixi page, and the source account label used in Quixi.
2. Either extract from the ChatGPT tab you are signed in to (the extension
   performs the page's own session/list/conversation requests in that tab and
   keeps every record verbatim), or pick an official export file.
3. The bundle is staged in the extension's private storage and hashed, then
   offered to the paired Quixi page. Quixi shows the offer; nothing is imported
   until you accept it there. Transfers acknowledge every chunk and resume from
   the committed offset after a reconnect.

Origins are requested only when you press Start; no content script is declared
statically. The extension never normalizes, deduplicates or writes SQL — Quixi's
importer does that after acceptance. Design and provider review:
[ADR 0035](../../docs/decisions/0035-browser-extension-import.md).

```sh
npm run build:extension      # apps/extension/dist — load unpacked in chrome://extensions
npm run test:extension       # typecheck + unit tests (transfer sender, shape checks)
npm run test:extension:e2e   # real Chromium, synthetic ChatGPT origin, shared panel
```

`QUIXI_EXTENSION_TEST_ORIGINS` pre-grants loopback origins in a test build only.
