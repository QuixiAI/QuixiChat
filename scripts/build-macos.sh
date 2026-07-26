#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

# Request the standalone application explicitly. Building only `dmg` makes
# Tauri treat the .app as disposable staging input for the disk image.
cargo tauri build --bundles app,dmg --no-sign --ci

app="$root/target/release/bundle/macos/QuixiChat.app"
dmg="$root/target/release/bundle/dmg/QuixiChat_0.0.1_aarch64.dmg"
test -d "$app"
test -f "$dmg"

echo "preserved $app"
echo "created   $dmg"
