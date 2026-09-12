# 11 — Build browser-extension history import

**Status:** Planned

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

- [ ] Choose the initial provider and browser target based on validated source fixtures and extraction feasibility. Document provider-specific permissions, applicable terms, authentication/session handling, and technical extraction method before shipping that extractor.
- [ ] Implement the extension manifest, background/content boundaries, progress UI, and narrowly scoped provider extractors. Add providers independently with versioned extraction fixtures.
- [ ] Define a versioned transfer protocol for ProviderImportBundle records, attachments, acknowledgements, backpressure, cancellation, and resumable progress.
- [ ] Implement browser-to-Quixi transfer and desktop pairing through the HostClient boundary. Validate the intended receiving instance and reject unsolicited/unpaired transfers.
- [ ] Extract provider-native IDs, timestamps, branches, available attachments, and raw source records. Leave normalization and deduplication policy in the importer.
- [ ] Implement Import new conversations using source identity/checkpoints and retry changed records safely. Surface expired sessions, unavailable content, and provider markup/API changes as distinct failures.
- [ ] Integrate discovery counts, commit progress, warnings, retry, and import reports with the shared application.

## Deliverables and interfaces

- A buildable extension with an explicitly supported extractor matrix and versioned bundle-transfer contract.
- Provider review records, pairing/transfer fixtures, and end-to-end extension-to-import tests.

## Acceptance criteria

- [ ] A supported provider conversation is extracted, normalized, stored, and searchable with preserved provenance.
- [ ] Repeated and interrupted transfers do not duplicate history or lose successfully acknowledged work.
- [ ] The extension never writes SQL, runs migrations, or invents canonical normalization rules.
- [ ] Expired sessions and unsupported source versions fail visibly without requesting broader permissions automatically.

## Boundaries and sequencing

The first extractor/provider is a research-and-review gate, not a promise of universal extraction support. Use official exports from plan 04 when extension extraction is unavailable. Keep extension work outside the canonical database owner.

[Back to the roadmap](./README.md)
