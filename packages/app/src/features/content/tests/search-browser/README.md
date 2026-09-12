# Exact conversation search navigation acceptance

Run from the repository root:

```sh
node --experimental-transform-types --test packages/app/tests/content/conversation-search.test.ts
npx tsc --noEmit -p packages/app/src/features/content/tests/search-browser/tsconfig.json
node packages/app/src/features/content/tests/search-browser/run.mjs
```

The browser runner imports the actual `apps/web/src/main.ts`, shared AppRoot, WebHost, and managed OPFS StorageClient. It serves a built application on a fresh port0 origin and uses fresh persistent Chromium/WebKit profiles. The helper only seeds synthetic canonical history, advances the real bounded index, inspects public replies, and creates an explicit canonical tombstone. No isolated storage implementation, test-only search backend, provider call, or pixel extraction is used.

A message has96 canonical parts:94 short text parts, a unique text hit in part95, and an Image in part96 with different filename and description terms. Only the first64 parts fit the normal initial view. Actual UI search clicks must display the exact separately fetched part; filename marking is confined to the canonical filename field. The retained worker-boundary trace must show direct part/message/attachment reads, exact `resolveConversationSearchHit`, and only the normal first64 parts page with a null cursor. It must contain no navigation mutation or enumeration of preceding part pages.

Seven check groups per engine cover filename focus beyond the visible page, ordinary text focus, caption field separation/normal navigation/canonical invariance, unsent draft protection across conversations, delayed metadata races, tombstoned stale-hit refusal, and390px layout/no external requests. The delayed-reply case holds one actual `readEntity` reply and later delivers the unchanged packet; storage and resolver behavior stay real. It proves a draft typed during lookup and a later normal navigation win over that pending search click. The unit suite separately checks a worker refusal after an equal-length rename, ownership/path mismatches, immutable locator capture, bounded admission, UTF16 boundaries and shared-client lifetime. Exact same-length filename/digest/tombstone SQL acceptance belongs to the storage resolver's pinned-WASM suite.

Results are written to `results/browser.json` with source fingerprints and actual request traces. `*-filename-mobile.png` shows the full narrow layout, and `*-filename-focus.png` captures the focused region. The report must pass its final source-stability check; temporary builds and profiles are removed. The current source is a missing-byte image attachment, so this proves filename metadata navigation without claiming image preview/download or OCR behavior.
