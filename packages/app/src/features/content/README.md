# Canonical content views

This shared React feature implements the display boundary from [product §19](../../../../../docs/product.md#19-content-parts) and a portion of [§29](../../../../../docs/product.md#29-core-chat-experience), tracked by [plan 08](../../../../../docs/plans/08_build_chat_and_library_ui.md). It reads through injected public `StorageClient` and `HostClient` instances. Display actions do not mutate canonical records or invoke retained tool calls.

```tsx
const access = createContentAccess({storage, host}); // one per app session
<ContentPartView part={part} access={access} />
// During application shutdown, before closing the clients:
await access.dispose();
```

Import the exports from `features/content/index.ts`. A changed part identity or access instance resets the view and releases its resources. Unmount releases text readers, image URLs and prepared files; asynchronous results arriving after unmount release themselves. Session disposal waits for pending reads/preparation before closing held leases. UI controls have accessible names and explicit opening, source and save actions.

## Display and resource limits

- Text and notes render Markdown, GFM tables/tasks, fenced code and locally bundled LaTeX. Source remains available. Raw HTML is skipped, remote Markdown images are represented as text, and only credential-free absolute HTTP(S) links are enabled. Explicit links open separately with `noopener noreferrer`.
- Parsing admits at most 16,384 characters, 256 lines and 2,048 formatting delimiters. Cheap checks reject deep links, indentation and quote nesting before parsing. The Markdown tree is limited to 2,048 nodes/depth 32. Math is limited to 32 expressions, 4,096 characters each, brace depth 32, 100 expansions and size 20; the resulting HTML tree is limited to 12,000 nodes/depth 80. Rejected input remains readable in source sections. These are explicit work bounds with measured hostile fixtures, not a proof that every parser input has a fixed latency.
- Fenced code in a supported language (JavaScript/TypeScript, Python, JSON, shell, SQL, CSS, HTML/XML, YAML, Rust, Go, Java, C/C++, C#) is coloured by a dependency-free tokenizer in `highlight.ts` (since 2026-09-09): anchored, linear patterns classify comment, string, number, keyword, builtin and punctuation runs, the tokens concatenate back to the exact input, blocks over 16,384 characters or 8,192 tokens and unknown languages stay plain, and colouring never affects the source view.
- Each fenced block offers "Copy code" only when the host reports the clipboard capability available (since 2026-09-10); the exact block text goes through `HostClient.writeClipboardText`, a successful write is announced as a status and a refused one as a readable alert. The proof reads the text back in Chromium; WebKit gates clipboard reading behind platform UI, so its evidence is the successful write.
- Blob-backed text pins a verified blob anchor and reads 16 KiB ranges. A fatal UTF-8 decoder preserves complete characters at section boundaries. No whole blob is decoded into a string. Formatting is local to the section/part; Markdown spanning boundaries is not reconstructed.
- At most two previews or prepared files are held across the app's access instance. Storage child ranges close after each read. Host download staging is bounded to 8 MiB and streams chunks; a separate Save action supplies the user gesture. Larger originals remain retained and receive a readable limitation.
- Inline images require available canonical bytes, PNG/JPEG MIME/header agreement, at most 8 MiB, at most 16 million pixels, and at most 16,000 pixels per dimension. Header admission precedes browser decoding. Decode failure releases the URL and leaves access to the original. SVG and other formats can be saved but are not rendered inline.
- Missing attachments have a readable availability state. Structured/tool/provider content is inert, paginated source. Provider-artifact downloads contain the full referenced raw blob; its retained locator identifies the relevant record.

Inline audio playback, richer document previews, downloads above the current host limit, cross-part formatting, and exhaustive keyboard/screen-reader qualification remain product work. This feature does not complete plan 08. Bundling KaTeX and the Markdown pipeline currently produces a Vite chunk-size warning; a shared UI loading/chunk policy remains an integration decision.

## Dependency review

All dependencies are exact pins with MIT licenses. Installed versions are `react-markdown@10.1.0`, `remark-gfm@4.0.1`, `remark-math@6.0.0`, `rehype-sanitize@6.0.0`, `rehype-katex@7.0.1`, and `katex@0.16.47`. The last pin matches rehype-katex's supported 0.16 dependency line and is deduplicated with its transitive parser dependency. The installation audit reported zero advisories on 2026-09-08; this is point-in-time evidence.

[react-markdown](https://github.com/remarkjs/react-markdown) builds React elements and documents that custom plugins and URL transformations affect its default safety. The implementation does not enable raw HTML or MDX. [remark-gfm](https://github.com/remarkjs/remark-gfm) supplies the bounded GFM representation. [rehype-sanitize's mathematics example](https://github.com/rehypejs/rehype-sanitize#example-math) recommends sanitizing before the trusted math transform and allowing only its marker classes; this avoids allowing arbitrary imported inline styles. Our schema follows that ordering. [rehype-katex](https://github.com/remarkjs/remark-math/tree/main/packages/rehype-katex) supplies the transform; [KaTeX security](https://katex.org/docs/security) and [options](https://katex.org/docs/options) support the explicit `trust: false`, expansion and size controls. Fonts and CSS are bundled locally; no CDN is used.

## Acceptance evidence

Run from the repository root:

```sh
node --experimental-transform-types --test packages/app/src/features/content/tests/bounds.test.mjs
node --experimental-transform-types packages/app/src/features/content/tests/browser/run.mjs
npx tsc --noEmit
```

Seven unit tests cover admission/tree bounds, URL/name policy, image header/dimension rejection and the code tokenizer (language aliases, per-family classification, lossless output, hostile and over-budget inputs). The [recorded browser run](./docs/browser-evidence.json) passed nine checks in each Chromium and WebKit using disposable persistent profiles on port 4197, the production archive worker, pinned SQLite WASM/OPFS and the production web host. It tests actual canonical records, verified UTF-8 ranges across a four-byte scalar, lease admission, local PNG decoding, a downloaded file's exact SHA-256, inert hostile content, coloured fenced code beside a plain unknown-language block, code copy through the host clipboard, safe-only citation links, redacted reasoning, structured data, provider artifacts, audio attachments and notes (since 2026-09-09), measured nesting/recursive-math fallbacks, unchanged sync-operation count, and release on view unmount (followed by successful reallocation before session disposal). Fixtures are synthetic; no external provider is contacted. The harness writes fresh machine-readable evidence and screenshots under `test-results/`; the Chromium screenshot was visually inspected for readable code, math, tables and attachment controls. These browser results do not substitute for a native WebView content-rendering qualification.

Conversation search clicks use `conversation-search.ts` and `ConversationSearchFocus.tsx`. One directly fetched canonical part is retained separately from the library's bounded part page; source IDs never become a page-enumeration loop or canonical branch mutation. The controller reads the exact part and message, checks their ownership, optionally reads Image filename metadata, then asks the public worker resolver to validate the current exact chunk/head/source and returned position. Missing, tombstoned, renamed or mismatched results are refused rather than retargeted. A filename locator (`attachment/<id>/filename`) produces a separately labeled, at-most4096-UTF16 canonical filename passage; its offsets are never applied to description text. Other part kinds retain the existing bounded renderer and explicit blob-reading controls; this does not introduce an arbitrary UTF16 seek API for long text blobs.

Opening a conversation or changing its displayed part/page clears focus. Pending lookup locators are copied before awaiting, only one lookup is admitted, stale completions are discarded, and shared storage is never closed by the focus controller. AppRoot rechecks navigation and unsent/live-work state after the asynchronous lookup, so a newly typed draft or later normal navigation cannot be overwritten by the search click. [The production browser proof](tests/search-browser/README.md) covers parts95/96 beyond the normal first64-part page and exact filename/description separation.

The focused panel appears only after the matching conversation view has loaded. Composer input and sending are briefly disabled during that final transition; typing remains available during metadata lookup and is rechecked before any cross-conversation transition. The final seven-group browser proof includes a held real metadata reply to verify both draft preservation and newer-navigation precedence.
