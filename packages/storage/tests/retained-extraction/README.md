# Exact retained extraction recovery

Run `node packages/storage/tests/retained-extraction/run.mjs`. The actual Chromium
and WebKit run passed five check groups and ten SQL variants per engine on
2026-09-09. Root `tsc --noEmit` also passed. The
[browser report](evidence/browser-evidence.json) records engine/platform details,
19 source fingerprints, built artifact hashes, literal source/candidate IDs and
file inventories. CI should retain this directory's `evidence/**`.

The source uses the production managed StorageClient to upload immutable bytes,
atomically register an attachment/document, and commit a real
`beginDocumentExtraction` receipt and stable claim. Public export, restore,
review and activation select a new canonical archive. The public
`reconcilePreviousArchiveExtraction` helper then closes its captured original
client and reads the original archive's exact surviving extraction receipt.
Instrumentation captures source file hashes after owner closure and before that
first retained read; every subsequent approved/rejected read preserves them.
This proves receipt recovery and owner/selection behavior, not PDF parsing: the
small synthetic PDF declaration is used only for the storage identity boundary.

Verified behavior:

- Same-selection recovery rejects before closing the live client, whose
  diagnostics remain usable. Invalid input also rejects before recovery effects.
- A matching schema-10 claim and receipt return the exact request digest/result;
  the helper also checks the caller's expected digest. Digest disagreement stays
  `UNKNOWN_OUTCOME`.
- A completely absent operation is `not_committed`. An identity reserved by a
  different canonical journal or local domain conflicts. No identity is replayed
  or redirected into the selected archive, whose clean copy has no old claim.
- Missing receipt rows/tables, mismatched receipt digests, invalid or oversized
  JSON, orphan receipts, and unfenced pre-10 receipts cannot produce success or
  an inferred absence. They remain `UNKNOWN_OUTCOME` with the original identity
  retained for recovery.
- Genuine schema-8/9 databases without extraction receipts return absence and
  retain their original ledger/file bytes. No migration or derived repair runs.
- The retained worker rejects an extraction mutation at its public allowlist.
  All ten damaged/legacy fixtures use separate synthetic UUID namespaces;
  private fixture SQL never changes the production default source.

The new public retained operation is `getExtractionOperation`. Its reader uses
only bound SELECTs, the validated stable claim, and at most 16 KiB of receipt JSON
(the current extraction writer's receipt limit). It does not construct a writable
ExtractionRepository or initialize repairable tables. Existing retained-reader
namespace, owner-lock, read-only SQLite, query-only, pool-preflight and ledger
checks remain in force.

`reconcilePreviousArchiveExtraction(storage, { operationId, requestDigest })`
returns `'committed' | 'not_committed'`. Callers must drain workflows sharing
`storage` before this explicit recovery action: it closes that original client
to release the owner lock. The helper checks that selection has changed, captures
the old literal archive ID before awaiting, and never opens a replacement writer.
Any missing claim with a surviving receipt, or claim with a missing receipt, is
uncertain. Only absence of both authorities permits `not_committed`; corruption,
owner contention and incompatible schemas remain explicit errors.

This adds exact digest evidence to retained recovery. Controller coordination
and the user-facing decision to open another archive remain separate integration
responsibilities. These tests do not simulate a filesystem crash or claim that
every possible read is byte-inert; they record unchanged bytes for these actual
scenarios and retain the pre-existing hot-journal refusal policy.
