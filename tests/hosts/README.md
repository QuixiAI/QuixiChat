# Desktop storage proof

This runs the shared `/storage-proof` screen in an actual Tauri WebView using
the production Vite assets embedded in a development-profile native binary.
It uses the same Storage Worker, SQLite WASM, OPFS SAH pool, Web Lock, and
BroadcastChannel as web. The native shell never reads or writes the database.
It addresses [plan 01](../../docs/plans/01_prove_universal_storage.md) and
[product §6.1](../../docs/product.md#61-quixi-desktop).

From the repository root, after `npm ci` and `npm run sqlite:build`:

```sh
python3 tests/hosts/run_tauri_storage_proof.py
```

The command builds the desktop frontend and Cargo's opt-in `storage-proof`
feature, opens the main WebView and a hidden follower WebView, runs the checks,
exits, and restarts the process against the same synthetic proof namespace.
It fails on a failed check,
missing report, or timeout and writes `test-results/tauri-storage-proof.json`.
Each run uses a fresh, isolated proof namespace and leaves its small synthetic
database for inspection. `--skip-build` reuses an existing proof binary and
should be used only when its inputs have not changed. `--output PATH` records
reviewable evidence elsewhere. This runner needs a working desktop session.

The feature-only reporting command and injected test script are absent from
ordinary desktop builds. The CSP permits same-origin workers and WASM fetches,
and adds the scoped `'wasm-unsafe-eval'` directive required by
[Tauri's CSP documentation](https://v2.tauri.app/security/csp/).

## Measured result

[macOS 26.5.2 result](results/tauri-macos-26.5.2.json), captured 2026-09-08:

- Apple Silicon, system WebKit `21624.2.5.11.8`, Tauri `2.11.5`.
- Bundled origin `tauri://localhost`; secure context true, cross-origin
  isolation false. The user-agent's `605.1.15` token is recorded verbatim;
  it is not used to infer the actual framework version.
- SQLite `3.53.4`, sqlite-vec `v0.1.9`. Bundled WASM is byte-identical to the
  pinned distribution, SHA-256
  `dd7c22431a3b8ad51ab5e6ed91065593574c34c5959d2efdef2f17484eedcb2c`.
- The write phase passed 22 checks and the process-restart phase passed 23:
  shared backend initialization,
  integrity, durable record and atomic proof operation, FTS diacritic search,
  vector nearest-neighbor distance, transaction and migration rollback,
  SQLite-full recovery, close/reopen, and abrupt worker termination with an
  uncommitted transaction followed by recovery. Two actual WebViews reported
  the same owner, a follower mutation appeared in the owner's client with its
  atomic operation, and terminating the owner during an uncommitted write
  transferred ownership to the surviving follower while preserving both
  committed records. The follower's committed write survived process restart.
- Test coordination uses a separate bounded BroadcastChannel. Each WebView
  runs its own shared `StorageProofClient`; the coordination channel never
  substitutes for storage ownership or forwards SQL. A readonly diagnostics
  request encountered the expected owner-transition error and was retried;
  no mutation was replayed.
- `navigator.storage.persist()` returned false in both phases. The reported
  quota was 20,615,843,021 bytes; it was not filled. Short process-restart
  durability passed despite persistence not being granted.

This establishes the tested universal backend path on this macOS/WebKit
combination. It does not establish eviction resistance, actual browser quota
exhaustion, OS crash or power-loss durability, contention at product scale, signed
installer behavior, Safari behavior, or Linux/WebKitGTK and Windows support.
Those remain separate plan-01 and release gates. The SQLite-full probe uses a
small database page limit and is not an OPFS quota test.
