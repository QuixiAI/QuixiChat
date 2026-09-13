# Desktop release bundle (macOS): artifact integrity and signing state

Plan [24](../plans/24_validate_scale_and_release_hosts.md) task 7, the
desktop artifact part. `npm run build:desktop` then
`node tests/hosts/desktop-bundle-proof.mjs`. Last run 2026-09-13 on macOS
26.6.2 (arm64), Tauri CLI 2.11.4; [retained report](results/desktop-bundle-macos.json),
11 checks.

## What is checked

- **Artifacts.** `target/release/bundle/macos/Quixi.app` and one disk image
  `Quixi_0.0.1_aarch64.dmg` (91,183,059 bytes); `hdiutil verify` confirms
  the image's checksum. The report records SHA-256 of the disk image, the
  main executable (95,074,000 bytes) and the embedded frontend dist (133
  files including the SQLite and embedding WASM modules) as the release
  inventory for this build.
- **Identity.** The bundle's own `Info.plist` carries `ai.quixi.chat`,
  version `0.0.1`, executable `quixi-desktop`, minimum system 10.13.
- **Signature, as found.** Before this run the bundle was only
  linker-signed: no sealed resources and an unbound `Info.plist`, so
  `codesign --verify --deep --strict` failed ("code has no resources but
  signature indicates they must be present"). `tauri.conf.json` now sets
  `bundle.macOS.signingIdentity` to `-` (ad-hoc), which seals the bundle;
  the signature verifies deep and strict with the hardened runtime flag.
  There is **no Developer ID identity on this machine** (0 codesigning
  identities), so the bundle is ad-hoc signed: it runs locally but cannot
  pass Gatekeeper on another Mac or be notarized. A real identity overrides
  the ad-hoc default through `APPLE_SIGNING_IDENTITY` at build time.
- **Gatekeeper.** Assessments are disabled on this machine
  (`spctl --status`), so the acceptance it reports ("override=security
  disabled") says nothing about distribution; the proof records the status
  and asserts a rejection only where assessments are enabled.
- **Updater.** No updater plugin is configured (`plugins` is null); there
  is no update channel, endpoint or public key. Updates are a reinstall.
- **CSP.** The desktop window's policy allows `'wasm-unsafe-eval'` and
  same-origin workers only.

## Not covered

- Distribution signing and notarization (a Developer ID is a user gate),
  an update channel, Windows and Linux bundles, and installation on a
  clean machine.
- Upgrade persistence (an archive created by one build opened by the next)
  and native integrations of the release bundle; the native proofs run
  feature-gated debug binaries, not this bundle.
