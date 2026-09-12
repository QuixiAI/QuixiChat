# 11 — Build browser-extension history import

**Status:** In progress — Chromium MV3 extension with a user-driven ChatGPT web extractor and official-export transfer, the versioned bundle-transfer protocol with pairing, the web-host receiver and the shared-panel integration are implemented and qualified against a synthetic provider ([ADR 0035](../decisions/0035-browser-extension-import.md), [validation](../validation/extension-import.md)); a real-account run, other browsers/hosts and the OpenAI terms text remain open

**Workstream:** B2/B3 — extraction and incremental transfer

**Depends on:** [04](./04_import_provider_exports.md), [05](./05_implement_host_capabilities_and_relay.md)

## Outcome

Provide a browser extension that extracts supported provider history and transfers it into the existing import pipeline, including incremental updates.

## Product references

- [3. Product pillars](../product.md#3-product-pillars)
- [23. Historical import](../product.md#23-historical-import)
- [24. Browser extension architecture](../product.md#24-browser-extension-architecture)
- [25. Incremental import](../product.md#25-incremental-import)
- [26. Import provenance](../product.md#26-import-provenance)
- [27. Import transactions](../product.md#27-import-transactions)
- [28. Import UX](../product.md#28-import-ux)
- [104. Track B — Historical Import](../product.md#104-track-b--historical-import)
- [108. First compelling migration build](../product.md#108-first-compelling-migration-build)
- [110. Release/platform risks](../product.md#110-releaseplatform-risks)

## Tasks

- [x] Choose the initial provider and browser target based on validated source fixtures and extraction feasibility. Document provider-specific permissions, applicable terms, authentication/session handling, and technical extraction method before shipping that extractor. — ChatGPT web on Chromium MV3; Claude web withheld under Anthropic's consumer terms; permissions (`scripting`, `storage`, optional per-origin host grants on the user's action), session handling (bearer token from the signed-in tab, never stored) and the observed extraction method are recorded in [ADR 0035](../decisions/0035-browser-extension-import.md). OpenAI's terms text could not be fetched (HTTP 403); the product owner's 2026-09-12 user-driven-access decision authorizes the extractor.
- [x] Implement the extension manifest, background/content boundaries, progress UI, and narrowly scoped provider extractors. Add providers independently with versioned extraction fixtures. — `apps/extension`: MV3 manifest, module service worker (opens the import tab), the import page with progress/cancel/reconnect, an idempotent bridge content script for the Quixi origin and the ChatGPT extractor content script (`chatgpt-web-conversation-observed-2026-v1`); unit tests use the synthetic ChatGPT fixture, the end-to-end proof a synthetic provider origin.
- [x] Define a versioned transfer protocol for ProviderImportBundle records, attachments, acknowledgements, backpressure, cancellation, and resumable progress. — `packages/core/src/contracts/extension-import.ts` (version 1): the bundle envelope with digest, discovery counts and checkpoint; offer/accepted/rejected, chunk/ack with a 256 KiB chunk and four-in-flight bound, resume from the committed offset, cancel/failed, staged and imported; validators for both directions; unit tests in core and for the sender.
- [ ] Implement browser-to-Quixi transfer and desktop pairing through the HostClient boundary. Validate the intended receiving instance and reject unsolicited/unpaired transfers. — Browser-to-Quixi is done: `HostCapabilities.extensionTransfers`, `HostClient.extensionBridge` (web host listener, per-session six-digit pairing code, digest-verified staging adopted as a selected file); wrong codes and unsolicited offers are rejected and every transfer needs an explicit accept (panel proof, both engines). Open: desktop pairing (the desktop host reports the capability unavailable; product §6.1 lists browser-extension pairing for Tauri).
- [x] Extract provider-native IDs, timestamps, branches, available attachments, and raw source records. Leave normalization and deduplication policy in the importer. — conversation records are kept verbatim (native ids, `create_time`/`update_time`, `mapping` parents/branches, attachment metadata counted as unavailable) and streamed as an export-compatible array into the unchanged importer profile; the extension performs no normalization.
- [x] Implement Import new conversations using source identity/checkpoints and retry changed records safely. Surface expired sessions, unavailable content, and provider markup/API changes as distinct failures. — per-(Quixi origin, account) checkpoint of the newest `update_time` after a complete import; "only new" fetches just newer conversations (end-to-end: nothing new → nothing sent; one added → one fetched); changed records are re-offered and deduplicated by the importer's native identity/revision rules; `session_expired`, `unavailable` and `format_changed` are distinct visible failures (end-to-end checks 1–2).
- [ ] Integrate discovery counts, commit progress, warnings, retry, and import reports with the shared application. — the offer shows discovered conversations and unavailable attachments; accepted bundles run the existing progress, warnings and report flows; the extension page shows transfer state and the final outcome. Open: a retry control for a failed accepted bundle on the Quixi side and surfacing the extension's discovery counts in the saved import report.

## Deliverables and interfaces

- A buildable extension with an explicitly supported extractor matrix and versioned bundle-transfer contract.
- Provider review records, pairing/transfer fixtures, and end-to-end extension-to-import tests.

## Acceptance criteria

- [ ] A supported provider conversation is extracted, normalized, stored, and searchable with preserved provenance. — proven end to end in Chromium against the synthetic ChatGPT origin (extracted, stored with `method: "extension"`, found by lexical search); the same flow against a real chatgpt.com account is the user's acceptance run and remains open.
- [x] Repeated and interrupted transfers do not duplicate history or lose successfully acknowledged work. — panel proof: interruption after the first acknowledged chunk resumes from the committed offset and the repeated bundle creates no duplicate thread; sender unit test: reconnect resends only unacknowledged bytes.
- [x] The extension never writes SQL, runs migrations, or invents canonical normalization rules. — the extension depends only on `@quixi/core` contracts and `@noble/hashes`; bytes reach storage solely through the host's staging and the existing importer (ADR 0035 ownership).
- [x] Expired sessions and unsupported source versions fail visibly without requesting broader permissions automatically. — end-to-end checks 1–2; `host_permissions` is empty and each origin is requested only from the user's Start action.

## Boundaries and sequencing

The first extractor/provider is a research-and-review gate, not a promise of universal extraction support. Use official exports from plan 04 when extension extraction is unavailable. Keep extension work outside the canonical database owner.

## Implementation and evidence

- Extension: `apps/extension/` (manifest, `src/background.ts`, `src/bridge.ts`, `src/chatgpt-extractor.ts`, `src/chatgpt.ts`, `src/transfer.ts`, `src/import.ts`, `build.mjs`); `npm run build:extension` is part of `npm run build`.
- Contract and hosts: `packages/core/src/contracts/extension-import.ts`; `apps/web/src/host/extension-bridge.ts`; desktop reports the capability unavailable.
- Application: extension region of `packages/app/src/features/imports/ImportPanel.tsx` and `controller.ts`; `ImportSource.method` carries `extension` through `packages/importers/src/normalize.ts`.
- Evidence: [validation](../validation/extension-import.md) with retained [panel](../validation/results/extension-import-panel-macos.json) and [end-to-end](../validation/results/extension-import-e2e-macos.json) records.

[Back to the roadmap](./README.md)
