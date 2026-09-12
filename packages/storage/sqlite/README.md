# Universal SQLite WASM distribution

This directory owns the single SQLite build required by [product §9](../../../docs/product.md#9-universal-sqlite-distribution) and [plan 01](../../../docs/plans/01_prove_universal_storage.md). Every browser, Docker web application, and desktop WebView uses the same generated module and binary through the Storage Worker.

## Build and verify

Requires Python 3.12+, Node 22+, Docker, and curl. No host C or WASM compiler is required. Downloads are cached under ignored `build/downloads/`. The first build pulls the pinned SDK image; ARM machines use Docker's amd64 emulation.

```sh
python3 packages/storage/sqlite/build.py
node packages/storage/sqlite/verify.mjs
```

The build verifies source hashes before extraction, starts from clean extracted source directories, and compiles in a fixed `/src` path inside the digest-pinned Emscripten image. Full compiler commands are recorded in `build/build.log`. Official SQLite build flags enable FTS5; `sqlite3_wasm_extra_init.c` statically registers sqlite-vec on all database connections. Filesystem-reading sqlite-vec helpers are omitted. The official JS OO API, BigInt bindings, and SAH-pool VFS remain available.

Outputs are ignored artifacts: `dist/sqlite3.mjs`, `dist/sqlite3.wasm`, and `dist/sqlite3.d.mts`. `sources.json` pins sources, licensing, compiler, and build settings. `artifacts.json` records reviewed sizes and SHA256 hashes plus SQLite's runtime source ID and compile options. A normal build rejects mismatches. After an intentional upgrade, run `node packages/storage/sqlite/verify.mjs --record` to record new reviewed hashes, then rebuild cleanly and verify reproducibility. Never use `--record` to conceal an unexplained mismatch.

The distribution smoke runs the actual WASM artifact and checks FTS5, vec0 float32 KNN, int8 L2, bit Hamming, commit/rollback, integrity, and close/reopen. It writes `dist/verification.json`. Its Node filesystem is ephemeral; these results do not establish OPFS durability or host support. The Storage Worker proof must exercise the identical hashes in real browser/WebView environments. Node initializes this same binary with an explicit `instantiateWasm` callback because the upstream default instantiator fetches browser URLs.

## Worker integration

```js
import sqlite3InitModule from './dist/sqlite3.mjs';
globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
const sqlite3 = await sqlite3InitModule({ locateFile: () => wasmAssetUrl });
const pool = await sqlite3.installOpfsSAHPoolVfs({
  name: 'quixi-storage',
  directory: '/quixi/database/proof',
  initialCapacity: 6,
});
const db = new pool.OpfsSAHPoolDb('/proof.sqlite3', 'c');
```

The upstream configuration disables automatic startup of its other OPFS VFSes, which otherwise need an additional proxy worker asset. SAH-pool remains enabled. Acquire the namespace's Web Lock before installing its pool. The worker exclusively owns both the pool and SQLite. Close connections before `pool.pauseVfs()` when releasing ownership; `pool.unpauseVfs()` asynchronously reacquires handles. SAH-pool uses synchronous OPFS access handles and requires a dedicated Worker and secure context, but does not require SharedArrayBuffer or cross-origin isolation. Fail clearly if the host cannot provide it. The Emscripten memory VFS is for distribution tests only, never a fallback for canonical history.

## Source references and licenses

- [SQLite official downloads and checksums](https://sqlite.org/download.html): pinned source and matching amalgamation are both 3.53.4; the matching amalgamation removes a host Tcl build dependency.
- [SQLite canonical WASM build](https://www.sqlite.org/wasm/doc/trunk/building.md): upstream API generation and compiled extension extra-init hook.
- [SQLite OPFS SAH-pool](https://www.sqlite.org/wasm/doc/trunk/persistence.md#vfs-opfs-sahpool): persistence implementation and ownership limitations.
- [sqlite-vec 0.1.9 release](https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9): archive SHA256 matches its upstream release digest. Quixi selects the MIT license; exact text is in `LICENSE-sqlite-vec-MIT`.
- [SQLite public-domain dedication](https://sqlite.org/copyright.html). Upstream license notices remain embedded in generated JS and C source.
- [Emscripten SDK](https://github.com/emscripten-core/emsdk): 4.0.10 image digest fixed in `sources.json`; compiler and bundled Binaryen metadata stripper come from that image.
