# Image-associated text search

Product [§91](../../../../../docs/product.md#91-images) permits search over image
filenames and descriptions without embedding pixels. These tests use actual
pinned SQLite WASM, canonical records, dirty triggers, shared StructuralChunker and
FTS. The setup checks the WASM artifact hash. The images are metadata fixtures:
this evidence does not claim image decoding, OCR, vector search, browser/OPFS
performance or a public attachment-renaming action.

```sh
npx tsc --noEmit -p packages/storage/tests/image-search/tsconfig.json
node packages/storage/tests/image-search/run.mjs
```

The six cases cover filename-only images with missing bytes, Unicode/NUL filename
offsets, media/thread filters, description identity and offsets unaffected by
filename indexing, immediate fencing after filename changes, actual canonical
missing-to-available resolution, null filename, deterministic rebuild, new Image
parts after the initial index, thread-title changes, and filename changes while a
long source remains held. Blob access throws if metadata indexing tries to read
image bytes.

A metadata-only SQL update tests the real canonical-table dirty trigger. Current
`ResolveAttachment` intentionally preserves filename/MIME, and there is no public
rename mutation yet. The SQL fixture update does not disable or bypass attachment
byte immutability. This proves the index responds when canonical metadata changes;
it does not invent an existing UI write path.

## Source and navigation addressing

- `p:<partId>` remains the exact existing description source. Description text,
  digest and `sectionPath: ['data','description']` are unchanged.
- `f:<partId>` is a separate filename source for an Image part with a nonempty
  canonical attachment filename. It uses shared message SearchChunks with exact
  message/part IDs and `sectionPath: ['attachment', attachmentId, 'filename']`.
  Half-open UTF-16 offsets address that filename, including original NUL/Unicode,
  rather than its description. Attachment identity is part of the chunk's hashed
  path. No filename is concatenated with description or generated from a blob hash.
- No source is invented for absent filenames. Missing image bytes do not remove
  retained metadata. Existing attachment MIME supports normal search filters.
- Filename and description results open the containing message. The current app
  does not apply search offsets to description text. Exact automatic focus on a
  part beyond the first bounded message-part page requires the separately
  proposed app navigation enhancement; this storage evidence does not claim it.

Image part writes enqueue both source keys. Bounded message/thread/global
expansion includes filename keys; attachment metadata updates use the existing
canonical global revision trigger. Head visibility and held-source signatures
therefore fence old names immediately before reindexing. Existing bounded cleanup
reclaims obsolete chunks. The extra derived trigger statements change the search
schema checksum: existing derived stores require the normal explicit repair path.
No canonical schema, core wire shape or embedding index changes are included.
