# Provider account setup validation

The following captures are historical setup evidence. The subsequent [native
regional connection validation](../../../docs/validation/native-regional-connections.md)
records the current 13 controller tests, 11 settings groups per browser engine
and 29 native regional checks, including credential-bound eligibility.

The implementation and official source review are recorded in [ADR0011](../../../docs/decisions/0011-provider-account-setup.md).

- `node --experimental-transform-types --test packages/app/src/features/providers/tests/controller.test.mjs`: three tests cover opaque reopen after a lost save reply and controller restart, replacement, disconnect, zeroed input bytes, unavailable credential/transport state, and the separate model/adapter capability and unknown-model review gates. The host in these unit tests is an explicit double.
- `node --experimental-transform-types packages/app/src/features/providers/tests/browser/run.mjs`: actual React StrictMode settings with production browser HostClient in Chromium and WebKit, controlled loopback HTTP, password input clearing, both adapter model probes and streams, handle rotation/revocation, and actual reload loss of session credentials. No provider account or paid request is used. The fixture server explicitly permits only this local harness origin. This is a settings/transport proof, not another canonical persistence proof; provider canonical persistence has its own existing suite.
- `python3 tests/hosts/run_tauri_native_host_proof.py --output test-results/provider-settings-native.json`: actual bundled macOS Tauri write/retarget/restart phases. Added checks exercise binding-only handle reopen, allocation conflicts, handle rotation, stale deletion, origin retarget rejection and complete process restart; existing native HTTP/cancellation tests also pass. The disposable keychain namespace is cleaned after the run.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml explicit_legacy_handle -- --nocapture`: an actual macOS keychain test establishes explicit legacy-handle read, migration into the single binding item, reopen with a new Secrets instance, authority fencing and cleanup.

The recorded [browser snapshot](./account-setup-browser-evidence.json) and [native snapshot](./account-setup-native-evidence.json) capture the successful 2026-09-08 native run and the 2026-09-09 browser run, after the settings controller began sharing one adapter per connection with chat. The browser feature screenshots were visually inspected for bounded cards, labeled input controls and overflow. The root TypeScript check and existing provider regression suite are also run after integration.

Open gates: actual paid/live provider smoke, final application composition qualification, real installed Safari, Windows/Linux keychain support, credential-store failure injection, multiple accounts/custom routes, token counting, input media mapping and tool invocation. The imported-history flow is independently validated under `packages/importers/docs/validation.md`.
