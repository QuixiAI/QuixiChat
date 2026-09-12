# Independent browser PDF layout acceptance

Run from the repository root after ordinary dependency provisioning:

```sh
node packages/documents/tests/layout-browser/run.mjs
```

The runner typechecks and bundles this isolated fixture, then launches actual
Chromium and WebKit processes. It uses the repository browser-engine selector,
so CI can select its installed engine explicitly. The source/asset hashes,
browser versions, process IDs, requests and per-page results are saved in
`evidence/browser-evidence.json`. Failed attempts remain in `evidence/attempts`;
source changes during capture invalidate the current qualification snapshot.

Production output comes from public `extractDocument`, with its actual two
workers, bounded range source and pinned PDF.js distribution. A separate
proof-owned `raw-parser.ts` loads the same pinned parser distribution directly
and streams raw page items through PDF.js `streamTextContent` with normalization
disabled. It imports neither Quixi's layout algorithm nor production worker.
Its output is an independent raw-input reference, not a second implementation
of the normalizer. The authored reading-order oracle is the separate
`fixtures/layout-manifest.json` and `layout-fixtures.md`, written before runtime
normalization. Expectations are not computed by calling `normalizePdfPage`.

Each text event's spans must form an exact partition. Every source-backed span
must match the independent item substring and its complete transform, width,
height and direction. Every original raw character must be covered exactly
once, even after reading-order reordering. All generated newlines and cell tabs
must have null provenance; other null spans must contain only whitespace.

The five authored pages check:

- Two independent column pages: full-width heading/footer, left paragraphs
  before right paragraphs, paragraph boundaries, and actual raw right-before-left
  drawing order that would fail a content-stream or row-major concatenation.
- One table page: Note/Item/Quantity raw column-major order becomes exact
  row-major cell associations with source-free separators.
- One code/list page: all eight code lines, exact two/four-space indentation,
  list continuation/nesting and separate prose boundaries.
- One mixed-rotation page: all raw items remain in source order, and page-end
  metadata explicitly reports `source_order` with `rotated_or_skewed`.

All pages require correct start/end/complete boundaries, exact item/UTF16
counts, successful page cleanup, and termination of every production/reference
worker. The exported version must be `quixi-layout-2`.

Only one raw reference page and one normalized page are held at a time (at most
256 reference items/16,384 UTF16 units for these fixtures). They are discarded
at page-end; reports retain hashes/counts rather than entire document text. A
proof-only source buffer is capped at 4 KiB. Production reads remain at most
64 KiB. This small-fixture oracle does not qualify maximum-document memory.

Only local fixture and bundled asset URLs are permitted by the server CSP and
browser routing. The owned raw parser independently disables external fetch,
XHR, WebSocket, importScripts, eval and Function. Its font resolver accepts exact
names from the pinned asset map; production uses its unchanged asset boundary.

This test qualifies emitted normalization/source mapping. Durable persistence of
the fallback notice, UI presentation, RTL, and native host replay of this new
normalizer are separate gates. The native PDF proof recorded before this change
must not be relabeled as proof of `quixi-layout-2`.
