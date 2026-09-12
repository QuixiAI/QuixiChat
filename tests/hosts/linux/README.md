# Linux Tauri / WebKitGTK storage gate

The actual Debian 12 arm64 Tauri host using WebKitGTK **2.50.6** fails the
universal storage proof. This is a measured backend limitation, not an
automation-access failure or an HTTP-versus-custom-origin assumption.

Run from the repository root after building the pinned SQLite distribution
and desktop frontend:

```sh
npm run build --workspace @quixi/desktop
python3 tests/hosts/linux/run.py --output tests/hosts/results/tauri-linux-bookworm-arm64.json
```

The command currently exits 1 because the tested host fails. Use
`--skip-image-build` to reuse the existing prerequisite image. The Dockerfile
pins Rust 1.97.1/bookworm by digest and installs
[Tauri's official Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux),
Xvfb, D-Bus, and software rendering dependencies. Apt package versions and the
built image ID are recorded in the report; package repositories are not frozen.

The runner copies an explicit allowlist of Cargo/native sources, current bundled
desktop assets, proof scripts, and the pinned SQLite WASM into temporary staging.
It excludes model downloads, legacy code, and macOS build trees. Cargo builds
with `--locked`, two jobs, and separate named Linux target/registry/git volumes.
The real Tauri application runs as a nonroot container user under Xvfb and D-Bus.
No WebKit sandbox-disabling option or privileged-container option is supplied.
The only persistent container resources are the image and those build caches;
the runtime home and synthetic OPFS files are discarded with the container.

## Evidence and diagnosis

The [recorded result](../results/tauri-linux-bookworm-arm64.json) contains the
following independent observations:

1. The shared two-WebView/process-restart proof loads in actual Tauri using
   `tauri://localhost`, but stops before SQLite initialization. The context is
   secure; Web Locks, workers, and BroadcastChannel exist. `navigator.storage`
   is absent under the default settings, so later proof checks cannot run.
2. A container-only, environment-gated native callback inspects the same Tauri
   runtime under both `tauri://localhost` and `http://127.0.0.1:1437`. Both are
   secure contexts and both lack the storage API by default. The HTTP route is
   diagnostic only and is not used as a production transport or backend.
3. The installed library's public feature API reports `AccessHandle` and
   `FileSystem` as mature, and `FileSystemWritableStream`, `StorageAPI`, and
   `StorageAPIEstimate` as stable. All five default to false. The standalone
   `features.c` probe records their settings and roundtrip toggles; its settings
   object does not host content. Feature status alone does not prove backend
   support on a particular platform.
4. A **test-only** interposition library enables exactly those five features
   through the documented
   [WebKitGTK feature-setting API](https://webkitgtk.org/reference/webkit2gtk/stable/method.Settings.set_feature_enabled.html)
   when the actual Tauri WebView obtains its settings. It is never linked into
   the app or copied into a release. This exposes the APIs but still fails the
   same SQLite proof. Bounded synthetic worker probes under **both origins**
   successfully call `getDirectory` and `getFileHandle`, then receive
   `NotSupportedError: Backend does not support this operation` specifically
   from `createSyncAccessHandle`.

The official [WebKitGTK 2.50.6 source release](https://webkitgtk.org/releases/webkitgtk-2.50.6.tar.xz)
has SHA-256
`2b281abf8894ffc6172152e5660b75eeeedbe1cc43d6783d09dc79f7c865bb42`.
Inspection of `Source/WebKit/Platform/IPC/SharedFileHandle.cpp:31` shows that
`SharedFileHandle::create` returns `std::nullopt` on non-Cocoa platforms.
`Source/WebKit/NetworkProcess/storage/FileSystemStorageHandle.cpp:213` maps that
failure to `BackendNotSupported`. This directly explains the observed sync
access-handle failure after the public API flags are enabled.

For [plan 01](../../../docs/plans/01_prove_universal_storage.md), this exact
Linux/WebKitGTK build is a **no-go**. A later release with a working native
sync-access-handle backend must pass the full identical proof before Linux
support is claimed. Changing origins or enabling these settings alone does
not resolve the measured failure. No alternative canonical backend was added.
These results do not claim anything about newer WebKitGTK builds, other Linux
distributions/architectures, or signed installer behavior.
