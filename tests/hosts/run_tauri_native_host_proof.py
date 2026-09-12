#!/usr/bin/env python3
"""Verify native HTTP/keychain through the real bundled Tauri TypeScript bridge."""
import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]

class Fixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disconnected = 0
    requests = 0
    routes = []

    def log_message(self, *_args):
        pass  # Never log credential-bearing synthetic requests.

    def do_POST(self):
        self.do_GET()

    def do_GET(self):
        # Registered query parameters may follow the path.
        self.path = self.path.split("?", 1)[0]
        Fixture.requests += 1
        Fixture.routes.append({"method": self.command, "path": self.path})
        if self.path == "/redirect":
            self.send_response(307)
            self.send_header("Location", "/echo")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path in ("/stream", "/idle"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            try:
                for count in range(500):
                    if self.path == "/idle" and count:
                        time.sleep(1)
                    self.wfile.write(b"A" * 8192)
                    self.wfile.flush()
                    time.sleep(0.01)
            except (BrokenPipeError, ConnectionResetError):
                Fixture.disconnected += 1
            return
        if self.path == "/slow":
            time.sleep(1)
        length = int(self.headers.get("Content-Length", "0"))
        if length > 8_388_608:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        result = json.dumps({"authorized": self.headers.get("Authorization") == "Bearer synthetic-secret", "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}).encode()
        try:
            self.send_response(429 if self.path == "/error" else 200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(result)))
            self.send_header("Retry-After", "3")
            self.send_header("Set-Cookie", "synthetic=not-forwarded")
            self.end_headers()
            self.wfile.write(result)
        except (BrokenPipeError, ConnectionResetError):
            Fixture.disconnected += 1

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--regions-only", action="store_true", help="Verify production regional metadata and separately identified synthetic loopback native dispatch")
    parser.add_argument("--providers-only", action="store_true", help="Run synthetic provider adapters with the registered native host fixture")
    parser.add_argument("--dialogs-only", action="store_true", help="Show actual native file panels and cancel them using feature-only AppKit sheet callbacks")
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/tauri-native-host-proof.json")
    args = parser.parse_args()
    if not args.skip_build:
        for command in (["npm", "run", "build", "--workspace", "@quixi/desktop"], ["npx", "vite", "build", "--config", "apps/desktop/tests/vite.host-proof.config.ts"], ["cargo", "build", "--locked", "-p", "quixi-desktop", "--features", "host-proof"]):
            subprocess.run(command, cwd=ROOT, check=True)
    binary = ROOT / "target/debug/quixi-desktop"
    namespace = str(uuid.uuid4())
    fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    alternate = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=alternate.serve_forever, daemon=True).start()
    env = {**os.environ, "QUIXI_HOST_PROOF_NAMESPACE": namespace, "QUIXI_HOST_PROOF_ORIGIN": f"http://127.0.0.1:{fixture.server_port}"}
    if args.dialogs_only or args.providers_only or args.regions_only:
        env.pop("QUIXI_HOST_FILE_PROOF_DIR", None)
        env.pop("QUIXI_HOST_FILE_PROOF_SHA256", None)
    phases = ("regions",) if args.regions_only else ("providers",) if args.providers_only else ("dialogs",) if args.dialogs_only else ("write", "retarget", "restart")
    result = {"host": "bundled-tauri-native-host", "timestamp": datetime.now(timezone.utc).isoformat(), "platform": platform.platform(), "namespace": namespace, "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "phases": [], "success": False}
    if platform.system() == "Darwin":
        result["systemWebKitVersion"] = plistlib.loads(Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").read_bytes())["CFBundleVersion"]
    credential = None
    try:
        for phase in phases:
            phase_env = {**env, "QUIXI_HOST_PROOF_PHASE": phase, "QUIXI_HOST_PROOF_CREDENTIAL": json.dumps(credential)}
            if phase == "retarget":
                phase_env["QUIXI_HOST_PROOF_ORIGIN"] = f"http://127.0.0.1:{alternate.server_port}"
            run = subprocess.run([str(binary)], cwd=ROOT, env=phase_env, capture_output=True, text=True, timeout=195 if env.get("QUIXI_HOST_FILE_PROOF_SHA256") else 105)
            lines = [line.split("=", 1)[1] for line in run.stdout.splitlines() if line.startswith("QUIXI_NATIVE_HOST_PROOF=")]
            entry = {"phase": phase, "exitCode": run.returncode, "stderr": run.stderr[-4096:]}
            if lines:
                entry["webview"] = json.loads(lines[-1])
                credential = entry["webview"].get("credential")
            else:
                entry["error"] = "Bundled WebView did not report native host results"
            result["phases"].append(entry)
            if run.returncode or not entry.get("webview", {}).get("success"):
                break
    except subprocess.TimeoutExpired:
        result["error"] = "Native host proof exceeded its bounded runtime"
    finally:
        try:
            cleanup = subprocess.run([str(binary), "--cleanup-host-proof"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=15)
            result["syntheticKeychainCleanup"] = {"exitCode": cleanup.returncode, "stderr": cleanup.stderr[-2048:]}
        except subprocess.TimeoutExpired:
            result["syntheticKeychainCleanup"] = {"exitCode": None, "error": "Synthetic namespace cleanup exceeded 15 seconds; cleanup is unverified"}
        time.sleep(1.2)  # Allow controlled server threads to observe native disconnects.
        fixture.shutdown()
        fixture.server_close()
        alternate.shutdown()
        alternate.server_close()
    result["fixture"] = {"requests": Fixture.requests, "observedDisconnects": Fixture.disconnected, "routes": Fixture.routes}
    result["success"] = len(result["phases"]) == len(phases) and all(phase.get("webview", {}).get("success") for phase in result["phases"]) and result["syntheticKeychainCleanup"]["exitCode"] == 0 and (args.dialogs_only or args.providers_only or args.regions_only or Fixture.disconnected > 0)
    if args.regions_only:
        result["scope"] = "Production native regional registration metadata, with separate origin-substituted loopback copies for actual Rust HTTP dispatch. No regional provider requests, account eligibility, or physical geography verified."
        result["success"] = result["success"] and Fixture.routes == [
            {"method": "GET", "path": "/v1/models"}, {"method": "POST", "path": "/v1/chat/completions"},
            {"method": "GET", "path": "/v1/models"}, {"method": "POST", "path": "/v1/chat/completions"},
        ]
        paths = [
            "apps/desktop/src-tauri/src/registered_destinations.rs", "apps/desktop/src-tauri/src/host/mod.rs",
            "apps/desktop/src-tauri/src/host/models.rs", "apps/desktop/src-tauri/src/host/secrets.rs",
            "apps/desktop/src-tauri/src/host_proof.rs", "apps/desktop/src-tauri/src/main.rs",
            "apps/desktop/src/host/index.ts", "apps/desktop/src/host/provider-connections.ts",
            "apps/desktop/tests/host-proof.ts", "apps/desktop/tests/regional-host-proof.ts",
            "tests/hosts/run_tauri_native_host_proof.py", "packages/core/src/contracts/host.ts",
        ]
        result["sourceSha256"] = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in paths}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["success"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
