# Published extraction → shared FTS acceptance

From the repository root:

```sh
npx tsc --noEmit -p packages/storage/tests/extraction-search/tsconfig.json
node packages/storage/tests/extraction-search/run.mjs
```

The [retained report](results/repository-wasm.json) records source hashes, canonical
migration checksums, platform and actual pinned SQLite WASM results. The fixture
uses real canonical, extraction and search repositories, transaction journals,
FTS5 and SQLite close/reopen. Synthetic text is staged with original-source-shaped
maps against the checked-in redistributable PDF attachment. It does not run PDF.js,
OPFS, browser workers or the public StorageClient.

The ten tests cover continuous cross-fragment phrases; page 1 staying searchable
while page 2 is paused/staged and then published without changing page 1's FTS
head; a 175,000-plus-unit Unicode/NUL page with exact source offsets; invisible
partial chunks; delayed-outbox replacement and held-source fences; SHA mismatch
without scope-trigger assistance; atomic ACK failure and actual `SQLITE_FULL`
rollback/retry; FTS repair retaining extraction maps/checkpoints/receipts; extraction
schema and detected text-corruption isolation from conversation FTS; 40-page bounded
outbox/enumeration across rebuild/reopen; zero-chunk scanned-page credit; and search cursor invalidation when extraction selection changes before outbox drain.

Every foreground admission is checked to add at most four shared chunks. The
40-page case verifies 32-event draining and bounded page enumeration. The actual
capacity case uses a small SQLite page cap in the memory VFS, not browser quota or
host disk exhaustion. A test-only attachment corruption case removes the canonical
immutability trigger before altering its hash: ordinary canonical writes correctly
reject that alteration, and the test isolates the independent search predicate.

Existing `packages/search/tests/repository.test.ts` continues to qualify canonical,
blob-backed and legacy extraction behavior separately. This work does not qualify
OCR, semantic retrieval, Cloud sync or the producer/UI composition.
