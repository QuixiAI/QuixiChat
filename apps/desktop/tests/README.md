# Native host acceptance proof

Run from the repository root on macOS:

```sh
npx tsc --noEmit -p apps/desktop/tests/tsconfig.json
python3 tests/hosts/run_tauri_native_host_proof.py
```

The runner builds the ordinary bundled desktop assets, bundles `host-proof.ts` with the real TypeScript host bridge, and builds the opt-in Cargo `host-proof` feature with `--locked`. It launches three native processes: write/stream/keychain checks, a retargeted-origin rejection check, and a restart/read/delete check. Its loopback servers receive synthetic data only. Keychain cleanup is constrained to `ai.quixi.chat.host-proof.<fresh UUID>` and does not inspect unrelated entries.

The committed [macOS evidence](../../../tests/hosts/results/tauri-native-host-macos-26.5.2.json) records actual WebView/OS versions, phase checks, binary hash, observed server disconnects and keychain cleanup status. Results apply to macOS 26.5.2 and system WebKit 21624.2.5.11.8 only. Source bundle output is ignored under `build/`; ordinary builds neither require nor run it. The production registry contains fixed global and regional API destinations; test-only loopback registrations are compiled behind `host-proof`.

Read [adapter limitations](../src/host/README.md#implemented-evidence-and-remaining-gates) before composing the bridge. Native keychain commits cannot be rolled back by cancelling an arbitrary request ID. The existing shared storage proof remains a separate feature and acceptance suite.

## File and dialog evidence

```sh
python3 tests/hosts/run_tauri_native_file_proof.py --output test-results/tauri-native-files.json
python3 tests/hosts/run_tauri_native_host_proof.py --dialogs-only --output test-results/tauri-native-dialogs.json
```

The [large-file result](../../../tests/hosts/results/tauri-native-files-macos-26.5.2.json) transfers 256 MiB through the actual binary WebView bridge, checks digest verification and chunk credits, saves to a synthetic destination, cancels another save while preserving its preexisting contents, and verifies normal temporary-file cleanup. It uses feature-only programmatic path selections inside a fresh temporary directory. OS `ps` samples native-process RSS only; it does not measure WebKit's JS heap or GPU/content processes. The initial measured transfer took about 80 seconds, so this is bounded-memory correctness evidence rather than an archive throughput target. Large-file proof phases allow up to 180 seconds.

The separate [native-panel result](../../../tests/hosts/results/tauri-native-dialogs-macos-26.5.2.json) disables fixture path substitution, presents actual NSOpenPanel/NSSavePanel sheets, observes them using safe AppKit bindings, and ends each sheet with the cancel result. This verifies real panel presentation/callback behavior. It does not claim tested human selection, overwrite confirmation, Accessibility automation, signed-app permissions or cross-platform dialog support. No global automation setting is changed and no existing user file is selected.

Anonymous staging closes on release/session teardown. Named destination-side temporary files are checked after normal cancellation; forced termination during copy can leave a private sibling and remains a documented recovery gate.

## Regional native registrations

```sh
cargo test --locked -p quixi-desktop
npx tsc --noEmit -p apps/desktop/tests/tsconfig.json
python3 tests/hosts/run_tauri_native_host_proof.py --regions-only --output tests/hosts/results/tauri-native-regions-macos-26.6.2.json
```

The regional phase compares real native US/EU capability metadata with the desktop connection bindings and the exact reviewed model/endpoint/modalities. Two separately identified loopback copies dispatch synthetic discovery and generation through the production native HTTP implementation. Changing the origin and binding strips regional evidence; the test does not weaken production evidence matching. The fixture verifies exactly four accepted HTTP requests. Wrong account, cross-region credential, unreviewed endpoint, wrong method and absolute-URL requests must all refuse before HTTP. Synthetic credential cleanup and source/binary hashes are retained in the report.

This is macOS native transport/configuration evidence. It makes no claim of a live eligible regional organization/project, regional model output, or physical processing geography. Region-constrained app routing remains a separate integration gate.
