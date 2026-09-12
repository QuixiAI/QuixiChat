# Cross-host restore: web export, native restore

Plan [09](../plans/09_add_archives_and_open_export.md) acceptance
"an archive exported from one supported host restores on another with
matching canonical records, branches, provenance, and blob hashes". Last run
2026-09-12 on macOS 26.6.2 (arm64), Node v22.23.1, Playwright Chromium (web
host) and the Tauri desktop WebView (macOS WebKit, native host).

## How it runs

`npm run test:app:cross-host:native` (`tests/hosts/archive-cross-host/run.mjs`):

1. **Web host.** The shared-app test harness runs in Playwright Chromium
   against the production Storage Worker. It seeds a small archive
   (6 conversations × 5 messages plus one
   conversation with a PNG attachment), indexes it, exports a portable
   archive in bounded steps, pulls the bytes, and reduces the archive to a
   per-collection digest (canonical JSON of every record, sorted by
   identity, over all fifteen collections: threads, thread states,
   contexts, messages, generations, parts, events, attachments, documents,
   raw objects, import sources, source identities, provenance, tombstones,
   summary proposals), a record count, the sync-operation count and the
   SHA-256 of every blob file under the archive's OPFS directory.
2. **Native host.** The bytes are bundled into a proof page, built with the
   production desktop configuration (same CSP, isolated data store,
   distinct app identifier) into `quixi-archive-cross-host-proof`, a Cargo
   binary next to the other native proofs. In the Tauri WebView the page
   opens a fresh isolated archive through the production Storage Worker,
   sends the bytes through `beginArchiveRestore` → `finishArchiveRestore`
   → `advanceArchiveJob` until the isolated candidate validates, reads the
   candidate's records back through the retained-archive reader, hashes
   its blob files from OPFS, and reports digests, counts and hashes only.
   Nothing is activated on either side.
3. **Comparison.** The runner requires every collection's count and digest,
   the record count (and the candidate summary's count), the sync-operation
   count and the sorted blob hash list to be identical.

## Result

Status **passed**, 4 checks. The web host exported 85 canonical records (818,688 bytes, 4 bounded steps); the native WebView validated the candidate at schema 12 in 7 steps (schema_validation → record_validation → blob_validation → ready, 117 ms) and read back 85 records; all fifteen collection digests, the record counts (85 web, 85 native, 85 in the candidate summary), the sync-operation counts (46) and the blob file hashes (1 file) are identical.

Retained report: [archive-cross-host-macos.json](results/archive-cross-host-macos.json).

## Limits

- The restored candidate is validated and read back, not activated; the
  activation and replacement review are proven on the web host in the
  archives proof. The native binary is a development-profile build with the
  production configuration, as the other native proofs are.
- One direction only (web → desktop). The reverse direction uses the same
  worker code on both sides; a desktop export restored on the web host is
  not separately run.
- The archive is small by design; scale is covered by
  [archive-scale.md](archive-scale.md).
