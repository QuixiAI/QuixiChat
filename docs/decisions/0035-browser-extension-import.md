# ADR 0035 — Browser-extension history import

Date: 2026-09-12. Status: accepted for plan 11's first vertical slice (ChatGPT
web extractor on Chromium MV3, versioned page transfer, shared-panel receiver).

## Provider and browser review (product §110.3)

| Item | Finding |
| --- | --- |
| Initial provider | ChatGPT web (`chatgpt.com`). Claude web is not shipped as an extractor: Anthropic's Consumer Terms of Service (effective 2025-10-08, read 2026-09-12) prohibit accessing the Services "through automated or non-human means, whether through a bot, script, or otherwise" except via an API key, and prohibit crawling, scraping or harvesting; the official Claude data export remains the supported path (plan 04) and the extension can transfer that file. |
| ChatGPT terms | OpenAI's Terms of Use pages (`openai.com/policies/terms-of-use`, `row-terms-of-use`) answered HTTP 403 to every fetch on 2026-09-12, so the current text could not be quoted here. The product owner decided on 2026-09-12 that an extraction the user starts and drives from their own signed-in session is not automated or bot access: "There is a human at keyboard clicking the button and driving the operation." That decision, not a terms reading, authorizes this extractor; the terms text remains an open item to record when it can be read. |
| Browser target | Chromium Manifest V3 (Chrome, Edge, Brave). Firefox/Safari MV3 differences are not addressed. |
| Permissions | Manifest: `scripting`, `storage`; `host_permissions` empty. `optional_host_permissions` name `https://chatgpt.com/*`, `https://*/*` (the user's Quixi origin) and loopback for fixtures; each origin is requested only when the user presses Start on the import page, per the Chrome permissions model. No content script is declared statically; scripts are injected with `chrome.scripting.executeScript` after the grant. |
| Session handling | The extractor runs in the signed-in ChatGPT tab and performs the requests the page performs: `GET /api/auth/session` for the bearer token, `GET /backend-api/conversations?offset&limit&order=updated`, `GET /backend-api/conversation/{id}`. Credentials never leave that tab; the token is not stored. 401/403 or a session without `accessToken` is a distinct `session_expired` failure; 429/5xx is `unavailable`; any unexpected shape is `format_changed`. |
| Extraction method | Undocumented internal API observed on 2026-09-12; the page's own conversation JSON has the same `mapping` tree as the official export, so records are kept verbatim and fed to the existing ChatGPT importer profile. Attachment bytes are not available through this path and are counted as unavailable attachments. |

## Transfer protocol

`packages/core/src/contracts/extension-import.ts` (protocol version 1). The
extension hands the importer one export-compatible byte stream plus a
`ProviderImportBundle` envelope (provider, extractor identity and source,
format profile, file name/type/size/SHA-256, discovery counts, source URL,
checkpoint). Messages cross the page boundary on the Quixi origin over
`window.postMessage`, tagged with the channel name and version; anything else
is dropped. Sequence: `offer` (with the page's six-digit pairing code) →
`accepted` (chunk size, window, committed offset) or `rejected`; `chunk`
(sequence, offset, bytes, final) → `ack` (committed offset); `resume` after a
reconnect → `accepted` from the committed offset; `staged` once every byte is
verified against the digest; `imported` with the run outcome; `cancel`/`failed`
either way. Chunks are at most 256 KiB, four in flight; extension messaging is
JSON, so the content script decodes base64 into transferred ArrayBuffers.

## Ownership

- The **web host** owns the page listener, pairing code, staging (the existing
  disk transfers with digest verification) and adoption of the verified stage
  as an ordinary selected `HostFile`; `HostCapabilities.extensionTransfers`
  reports availability and `HostClient.extensionBridge` exposes offers,
  progress, accept/reject/cancel and the outcome report. The desktop host
  reports the capability unavailable (no extension can reach the WebView).
- The **shared import panel** shows the pairing code, the pending offer with
  its provenance, and accepts only on the user's click with an account label;
  the staged file then runs the unchanged import pipeline (dedup, provenance,
  warnings, report). `ImportSource.method` records `extension`.
- The **extension** stages the extracted stream in its own OPFS, hashing
  incrementally, keeps a per-(Quixi origin, account) checkpoint of the newest
  `update_time` after a complete import, and never normalizes, deduplicates or
  writes SQL (product §24).

Unsolicited or unpaired transfers are rejected by the pairing code (rotated per
page session) and by the explicit accept; the page also requires same-origin,
same-window messages.

## Evidence

See [extension-import.md](../validation/extension-import.md): core validator
tests, extension unit tests for the transfer sender and shape checks, the
shared-panel receiver proof in Chromium and WebKit with a synthetic in-page
sender, and the real extension end to end in Chromium against a synthetic
ChatGPT origin (expired session, changed shape, full and incremental runs).
A real chatgpt.com run against the user's own account remains the acceptance
gate the user performs.
