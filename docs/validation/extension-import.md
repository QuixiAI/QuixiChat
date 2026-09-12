# Browser-extension import qualification

Date: 2026-09-12. Plan: [11](../plans/11_build_browser_extension_import.md).
Decision: [ADR 0035](../decisions/0035-browser-extension-import.md).

Environment: macOS 26.6.2 (Darwin 25.6.0, arm64), Node v22.23.1, Playwright
1.63.0 (Chromium `channel: "chromium"` new headless for the extension; Chromium
and WebKit for the shared panel). No real provider was contacted: the extractor
ran against a synthetic ChatGPT origin on loopback that serves the observed
session, list and conversation endpoints from the redistributable synthetic
fixture. The manifest used for the end-to-end run pre-grants the two loopback
origins (`QUIXI_EXTENSION_TEST_ORIGINS`), because automated Chromium cannot
answer permission prompts; the distributed manifest keeps `host_permissions`
empty and requests each origin on the user's action.

## Commands

```sh
npm run test:core                      # contract validators (3 new extension-import tests)
npm run test:extension                 # extension typecheck + 6 unit tests (sender, shape checks)
npm run test:app:imports:browser       # shared panel receiver, Chromium + WebKit
npm run test:extension:e2e             # real extension in Chromium against the synthetic provider
npm run check                          # includes the extension build
```

## Unit checks

- `packages/core/tests/extension-import.test.ts`: bundle envelopes validated
  field by field and bounded; inbound/outbound messages parsed structurally
  with oversized chunks and wrong-direction kinds dropped; six-digit pairing
  codes compared in full.
- `apps/extension/tests/transfer.test.ts`: chunks honour the page's chunk size
  and in-flight window; a dropped connection resumes from the committed offset
  with one `resume` and no duplicated acknowledged bytes; cancel notifies the
  page; a rejection ends with the page's reason.
- `apps/extension/tests/chatgpt.test.ts`: session, list and conversation shapes
  are checked before anything is trusted (`session_expired`, `format_changed`,
  `unavailable` classification); serialized records form an export-compatible
  `conversations` array with verbatim `mapping`; only-new selection.

## Shared panel receiver (`npm run test:app:imports:browser`)

Retained: [extension-import-panel-macos.json](results/extension-import-panel-macos.json),
17 checks per engine (the existing 13 plus four new ones), Chromium and
WebKit, with a synthetic in-page sender posting what the content script posts:

| Check | Chromium | WebKit |
| --- | --- | --- |
| wrong pairing code → `rejected`, nothing shown | pass | pass |
| paired offer shown with provenance; accepted explicitly; 256-byte chunks acknowledged; interruption after the first chunk; `resume` answered from the committed offset; digest verified; import completes with `ImportSource.method = "extension"` | pass | pass |
| same bundle again for the same account → acknowledged, imported, no duplicate thread | pass | pass |
| declining reports the refusal and stages nothing | pass | pass |

Qualification found and fixed one defect: the page applied chunks concurrently,
so two chunks in flight could be misread as out of order; chunk handling is now
serialized per offer.

## Extension end to end (`npm run test:extension:e2e`)

Retained: [extension-import-e2e-macos.json](results/extension-import-e2e-macos.json)
(five checks, 19 recorded provider requests, the test manifest, source hashes).

| Check | Result |
| --- | --- |
| expired session (`/api/auth/session` without a token) | distinct visible failure on the import page; no transfer |
| changed list shape (`conversations` instead of `items`) | reported as a provider format change |
| full run: two conversations extracted in the signed-in tab, staged in the extension's OPFS with an incremental SHA-256, offered with the pairing code, accepted on the Quixi page, imported by the production importer | 2 threads, `method: "extension"` provenance, lexical search finds the text |
| second run with the saved checkpoint | "Nothing new to import", nothing sent |
| provider gains one conversation | exactly one `/backend-api/conversation/…` request, one offer, one more thread (3) |

Qualification found and fixed: injected scripts registered a second listener on
repeated injection into the same tab (duplicate extractions interleaved their
writes); both content scripts are now idempotent per tab. The sender also did
not report its initial "offering" state.

## Limits and open gates

- Real chatgpt.com is untested here. The endpoints are undocumented internals
  observed on 2026-09-12; the acceptance run against the user's own account
  (plan 11 criterion 1 on a real provider) is the user's to perform, and any
  shape drift surfaces as `format_changed` rather than being guessed around.
- Claude web extraction is not shipped (Anthropic consumer terms, ADR 0035);
  the extension transfers official Claude exports instead.
- OpenAI's terms text could not be fetched (HTTP 403); the extractor ships on
  the product owner's user-driven-access decision recorded in ADR 0035.
- Attachment bytes are not available through the web client path; they are
  counted as unavailable attachments and the importer records the reference.
- Firefox/Safari extension platforms, desktop (Tauri) pairing and a resume
  after the extension page itself is closed (the OPFS stage survives; the UI
  has no "resume last bundle" control yet) remain open.

## Retry and saved report — 2026-09-12

The panel proof gained a fifth extension scenario, now 18 checks per engine
in Chromium and WebKit (retained record refreshed): the fixture makes the
next `importWorkSeal` storage request fail once while an accepted bundle is
importing. The run is saved `paused` with that cause, the extension receives
outcome `paused` with the same reason, the panel shows the error, and
"Resume selected import" completes the run from the staged bytes with no
second transfer (the count of `accepted` replies does not change). Import
details then show "Received from the browser extension · extractor
synthetic-sender (page extraction) · discovered 1 conversation, 1 attachment
(1 unavailable) · from …", the discovery counts the extension reported.

Environment note: WebKit shares one OPFS per origin across Playwright
profiles, and the web host retains at most four temporary downloads per
origin, so repeated WebKit runs that saved a report eventually refused the
next save. The fixture now clears retained downloads before mounting; the
product behaviour (bounded retention with explicit cleanup) is unchanged.
