# Compatible page layout metadata

Plan14 layout outcomes are persisted independently of text classification. Public
`PageLayout` and `assertPageLayout` describe:

```ts
{
  mode: 'geometric' | 'source_order';
  reasons: ('non_ltr' | 'rotated_or_skewed')[];
  columns: 1 | 2;
}
```

Geometric mode has no reasons. Source-order fallback has one or two unique known
reasons and one column. The assessment is capped at 512 serialized bytes.
`publishExtractionPage.args.layout` is optional for legacy producers.
`readExtractedPageText.result.layout` is required and nullable: **null means no
assessment was recorded**, not an inferred geometric success. The same page-level
outcome is included in every bounded text window, even a one-character read.
Classification remains independently `text` or `possible_scanned`.

## In-place compatibility

Extraction schema2 retains the exact v1 tables and adds
`quixi_extract_page_layout`. Before upgrading, the owner verifies the entire exact
v1 schema object set and v1 checksum/ledger. Only then does one transaction create
the table and update the ledger. Unknown, partial or corrupt schemas fail closed.
An interrupted transaction restores the previous DDL and ledger. Nothing deletes,
rewrites or reindexes existing published text, source maps, checkpoints, publication
references, operation receipts or stable operation claims during migration.

Unrecorded pages retain the exact old source-digest recipe and return `layout:null`.
A supplied layout uses a v2 source digest binding the assessment to the page's
identity/text/map hashes. Current-reference checks and bounded reads reconstruct
that digest. A missing, malformed or changed layout row on a v2 publication cannot
silently become an unrecorded v1 outcome. Source references keep their existing
wire shape. Stored publication receipts retain their historical meaning even if
later derived corruption prevents reading the current page.

Layout storage is charged to the existing run/archive logical budgets along with
its publication control receipt. A capacity refusal rolls back metadata, page
visibility, checkpoint changes and operation claims together. Obsolete-page cleanup
removes layout rows and releases their accounted bytes; historical receipts remain.

## Retained and old-code behavior

The frozen **actual pre-change v1 repository module** accepts the captured v1 data
and replays its receipt. On the upgraded database, a newly opened v1 repository
refuses initialization and subsequent extraction requests without writes. This
proof assumes the production archive-owner lock serializes versioned owners; it
does not claim an already-open arbitrary old context rechecks its schema per call.

The retained archive `getExtractionOperation` route was audited separately. It
reads the unchanged bounded operation row and matches the independent stable
operation claim under the canonical ledger; it does not initialize extraction or
require extraction schema1. The upgrade changes neither table nor receipt bytes.
The retained reader can therefore inspect old outcomes on schema2 without running
this migration. This is a code/unchanged-data compatibility audit, not a new
retained-browser transport claim.

A previous working run under another normalizer still requires explicit producer
recovery/interruption before a new-version run is admitted. The tests retain old
visible pages while the replacement has no published page and preserve old
operation retries throughout. The production persister owns the exclusive producer
lease before confirming interrupted work; the repository does not infer producer
loss from a changed normalizer alone.

## Evidence

```sh
npx tsc --noEmit -p packages/storage/tests/extraction-layout/tsconfig.json
node packages/storage/tests/extraction-layout/run.mjs
```

Ten tests use real pinned SQLite WASM with canonical/extraction repositories:
actual v1 upgrade/reopen and receipt replay; DDL interruption rollback/retry;
unknown/partial schema refusal; frozen v1 compatibility/refusal; transactional
layout publication/replay; deleted/malformed/changed metadata refusal; strict
bounds and unchanged legacy request shape; cleanup accounting; version-change
admission with preserved old pages; and logical budget exhaustion rollback.

`fixtures/v1.json` was captured from the actual schema1 implementation before
production changes, with one published page and a second staged checkpoint.
`fixtures/extraction-v1.mjs` is the frozen repository bundle, with input and artifact
hashes in its manifest. The test validates the bundle digest. Do not regenerate
these files with current code. The one-time `capture-v1.ts` script explicitly
refuses execution once the production schema version is no longer1.

These are Node SQLite tests. They do not establish OPFS quota behavior or image/PDF
parser correctness. Browser UI and native schema2/layout2 persistence acceptance
are separate captures maintained by their corresponding runners.
