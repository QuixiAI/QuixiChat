# Exact document search navigation acceptance

From the repository root:

```sh
npx tsc --noEmit -p packages/storage/tests/search-navigation/tsconfig.json
node packages/storage/tests/search-navigation/run.mjs
```

The [retained report](results/repository-wasm.json) records the pinned SQLite WASM
hash, source hashes, canonical migration ledger and actual test outcomes. Tests use
real canonical/extraction/search repositories and FTS5. The plain-text blob reader
is an injected bounded fixture; this suite makes no OPFS/browser/UI claim.

Seven tests cover:

- Exact published page identity and UTF-16 source offsets beyond 65,536 units in a
  Unicode/NUL page. Page-text loading is forbidden during resolution, no blob read
  occurs and SQLite's total-change count stays unchanged. The query plan confirms
  use of the `(epoch,chunk_id)` index.
- Refusal of old hits after clear or a changed replacement, including before the
  extraction outbox drains. Resolution never guesses a new page by document/page.
- Legitimate resolution of the same deterministic chunk after an unchanged rebuild;
  refusal while explicit repair has removed its head; exact resolution after that
  source is rebuilt.
- Plain document/code hits resolve to the correct attachment overview with null
  pageRef. Malformed chunk/document IDs, wrong documents and modified positions
  fail. Code-classified chunk identities retain the shared classifier's hash rule.
- Canonical attachment SHA changes invalidate extracted and plain navigation even
  with dirty triggers bypassed in a deliberate physical-corruption fixture.
- Missing extraction tables produce no joins against those absent tables, refuse
  extracted navigation and leave plain-document and conversation search usable.
- Legacy `x:` registrations without a durable PublishedPageRef are refused rather
  than assigned an invented page/map identity.

The resolver projects bounded position/digest/version/context metadata and at most
one current page reference. It reads neither complete page text nor source maps.
The caller uses the returned exact PublishedPageRef for the separate bounded text/
map APIs. Map coordinates are original PDF item coordinates and page-local UTF-16
ranges, not raw PDF byte offsets.
