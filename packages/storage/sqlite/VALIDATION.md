# Distribution validation — 2026-09-08

The SQLite distribution subsection of [plan 01](../../../docs/plans/01_prove_universal_storage.md) has a working source build. This is distribution evidence; the plan's platform gate still requires browser/WebView OPFS proofs.

| Check | Result |
| --- | --- |
| Source authenticity | SQLite source and amalgamation SHA3-256 match official download values; sqlite-vec SHA256 matches its release asset digest. |
| Toolchain | Emscripten 4.0.10, clang 21.0.0, Binaryen 123, digest-pinned linux/amd64 Docker image. |
| Reproducibility | Two subsequent clean source extractions/builds matched the original JS and WASM SHA256 values; the final declaration file also matched on a clean build. |
| Actual runtime | SQLite 3.53.4 and sqlite-vec v0.1.9 execute in the same WASM instance. |
| SQL smoke | Commit, rollback, close/reopen, integrity, FTS5 Unicode diacritic matching, float32 vec0 KNN, int8 L2, and bit-vector Hamming passed. |
| Worker API | Official OO API and `installOpfsSAHPoolVfs` retained; unused proxy VFSes can be disabled through upstream configuration. |
| Host scope | Node v22.23.1 on macOS ARM64; Docker amd64 compiler runs through emulation. This does not establish browser or WebView persistence. |

Reproduce with `python3 packages/storage/sqlite/build.py`; validate an existing artifact with `node packages/storage/sqlite/verify.mjs`. Runtime results are written to ignored `dist/verification.json`; full compiler commands are in ignored `build/build.log`. Reviewed artifact hashes and all runtime SQLite compile options are tracked in `artifacts.json`.

The binary is 1,599,767 bytes, SHA256 `dd7c22431a3b8ad51ab5e6ed91065593574c34c5959d2efdef2f17484eedcb2c`. The JS module is 814,433 bytes, SHA256 `127c4f37a4ce3449d464b976ac4979fc6b016ae974c0aea9ba8afef85d3b4d5d`.
