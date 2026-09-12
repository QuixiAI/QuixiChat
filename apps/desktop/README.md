# Desktop host

The frontend mounts the same `@quixi/app` used by web. `src-tauri/` provides the
[desktop HostClient bridge](src/host/README.md), with destination-bound native HTTP
and macOS keychain secret storage. Its ordinary destination registry starts empty;
application composition must explicitly register supported providers. It starts
no local inference server. Native commands provide host privileges, while the
shared StorageWorker owns canonical SQLite.

From the repository root:

```sh
npm run dev:desktop
npm run check:desktop
npm run build:desktop
```

The Tauri CLI runs this application's frontend hooks before development/build.
The root Cargo workspace contains this crate. Actual bundled macOS WebView
[storage evidence](../../tests/hosts/README.md) and
[native host proof](tests/README.md) accompany the implementation. Compilation
alone does not establish platform support; Windows remains unverified and the
tested Linux WebKitGTK backend has an unresolved canonical OPFS support gate.
