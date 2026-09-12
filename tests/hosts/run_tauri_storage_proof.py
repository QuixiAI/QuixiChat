#!/usr/bin/env python3
"""Run synthetic shared-storage checks in two bundled Tauri WebViews, then restart."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/tauri-storage-proof.json")
    args = parser.parse_args()
    if not args.skip_build:
        subprocess.run(["npm", "run", "build", "--workspace", "@quixi/desktop"], cwd=ROOT, check=True)
        subprocess.run(["cargo", "build", "-p", "quixi-desktop", "--features", "storage-proof"], cwd=ROOT, check=True)
    namespace = "tauri-proof-" + uuid.uuid4().hex
    binary = ROOT / "target/debug/quixi-desktop"
    wasm = ROOT / "packages/storage/sqlite/dist/sqlite3.wasm"
    bundled_wasm = list((ROOT / "apps/desktop/dist/assets").glob("sqlite3-*.wasm"))
    if len(bundled_wasm) != 1 or bundled_wasm[0].read_bytes() != wasm.read_bytes():
        raise RuntimeError("Bundled SQLite WASM must match the pinned distribution exactly")
    result = {
        "host": "bundled-tauri-webview", "platform": platform.platform(),
        "timestamp": datetime.now(timezone.utc).isoformat(), "buildProfile": "dev with custom-protocol",
        "macos": platform.mac_ver()[0], "namespace": namespace,
        "sqliteWasmSha256": hashlib.sha256(wasm.read_bytes()).hexdigest(),
        "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "phases": [], "success": False,
    }
    if sys.platform == "darwin":
        info = plistlib.loads(Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").read_bytes())
        result["systemWebKitVersion"] = info["CFBundleVersion"]
    for phase in ("write", "restart"):
        env = {**os.environ, "QUIXI_PROOF_NAMESPACE": namespace, "QUIXI_PROOF_PHASE": phase}
        try:
            run = subprocess.run([str(binary)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=105)
            lines = [line.split("=", 1)[1] for line in run.stdout.splitlines() if line.startswith("QUIXI_STORAGE_PROOF=")]
            entry = {"phase": phase, "exitCode": run.returncode, "stderr": run.stderr[-8192:]}
            if lines:
                entry["webview"] = json.loads(lines[-1])
            else:
                entry["error"] = "Bundled WebView did not report a result"
            result["phases"].append(entry)
            if run.returncode != 0 or not entry.get("webview", {}).get("success"):
                break
        except subprocess.TimeoutExpired:
            result["phases"].append({"phase": phase, "error": "Host process exceeded 105 seconds"})
            break
    result["success"] = len(result["phases"]) == 2 and all(p.get("webview", {}).get("success") for p in result["phases"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
