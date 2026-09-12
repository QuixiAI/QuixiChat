#!/usr/bin/env python3
"""Qualify regional conversation routing in an isolated native macOS WebView."""
import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import plistlib
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BINARY = ROOT / "target/debug/quixi-regional-app-proof"
MODEL = "gpt-4.1-mini-2025-04-14"
HOSTS = {"us.api.openai.com": "us", "eu.api.openai.com": "eu"}
MAX_BODY = 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class RegionalTlsFixture:
    """Actual HTTPS; the native client retains reviewed origins and TLS names."""
    def __init__(self, directory, certificate_hostnames=None):
        self.requests, self.errors, self.tls_checks, self.handshakes = [], [], [], []
        self.certificate_hostnames = certificate_hostnames or list(HOSTS)
        self.lock = threading.Lock()
        self.phase = "setup"
        self.ca = directory / "ca.pem"
        key, cert = directory / "server-key.pem", directory / "server.pem"
        ca_key, csr, extensions = directory / "ca-key.pem", directory / "server.csr", directory / "server.ext"
        extensions.write_text("subjectAltName=" + ",".join("DNS:" + name for name in self.certificate_hostnames) + "\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
        commands = [
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(ca_key), "-out", str(self.ca), "-days", "1", "-subj", "/CN=Quixi ephemeral regional proof CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
            ["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(csr), "-subj", "/CN=" + self.certificate_hostnames[0]],
            ["openssl", "x509", "-req", "-in", str(csr), "-CA", str(self.ca), "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(cert), "-days", "1", "-extfile", str(extensions)],
        ]
        for command in commands:
            result = subprocess.run(command, capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError("Ephemeral TLS certificate creation failed")
        self.certificate_sha256 = digest(cert)
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass  # Never log raw authorization or content.

            def handle(self):
                try:
                    super().handle()
                except (ConnectionResetError, BrokenPipeError):
                    pass  # Expected when a certificate-only self-check closes.

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def reply(self, status, body, content_type="application/json"):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

            def handle_request(self):
                self.connection.settimeout(15)
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 0 or length > MAX_BODY or self.headers.get("Transfer-Encoding"):
                        raise ValueError("Fixture request body framing exceeds its bound")
                    body = self.rfile.read(length)
                    if len(body) != length:
                        raise ValueError("Fixture body ended early")
                    host = self.headers.get("Host", "")
                    sni = getattr(self.connection, "quixi_sni", None)
                    payload = json.loads(body) if body else None
                    forced = bool(body and b"REGION_FORCE_FAILURE" in body)
                    entry = {
                        "phase": owner.phase, "sequence": len(owner.requests), "method": self.command,
                        "path": self.path, "sni": sni, "host": host, "region": HOSTS.get(sni),
                        "bodyBytes": len(body), "bodySha256": hashlib.sha256(body).hexdigest(),
                        "model": payload.get("model") if isinstance(payload, dict) else None,
                        "authorizationPresent": bool(self.headers.get("Authorization")),
                        "bearerAuthorization": self.headers.get("Authorization", "").startswith("Bearer "),
                        "credentialMatchesExpected": self.headers.get("Authorization") == "Bearer synthetic-native-" + str(HOSTS.get(sni)),
                        "relayHeadersPresent": any(name.lower().startswith("x-quixi-") for name in self.headers),
                        "forcedFailure": forced,
                    }
                    with owner.lock:
                        if len(owner.requests) >= 128:
                            raise ValueError("Fixture exceeded its bounded request count")
                        entry["sequence"] = len(owner.requests)
                        owner.requests.append(entry)
                    if sni not in HOSTS or host != sni or not entry["credentialMatchesExpected"] or entry["relayHeadersPresent"]:
                        raise ValueError("Native request violated the registered regional TLS/header binding")
                    if self.command == "GET" and self.path == "/v1/models" and not body:
                        entry["status"] = 200
                        self.reply(200, json.dumps({"object": "list", "data": [{"id": MODEL, "object": "model"}]}).encode())
                        return
                    if self.command != "POST" or self.path != "/v1/chat/completions" or not isinstance(payload, dict) or payload.get("model") != MODEL:
                        raise ValueError("Native request escaped the reviewed method/path/model scope")
                    if forced:
                        entry["status"] = 503
                        self.reply(503, b'{"error":{"message":"Synthetic regional fixture failure","type":"server_error"}}')
                        return
                    prefix = {"id": "synthetic-native-regional", "object": "chat.completion.chunk", "model": MODEL}
                    chunks = [
                        {**prefix, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Synthetic native regional answer. This fixture response contains no external provider output."}, "finish_reason": None}]},
                        {**prefix, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 13, "completion_tokens": 5, "total_tokens": 18, "prompt_tokens_details": {"cached_tokens": 0}}},
                    ]
                    response = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                    entry["status"] = 200
                    self.reply(200, response, "text/event-stream")
                except Exception as error:
                    with owner.lock:
                        owner.errors.append(type(error).__name__ + ": " + str(error))
                    try:
                        self.reply(400, b'{"error":{"message":"Synthetic fixture rejected request"}}')
                    except (OSError, ssl.SSLError):
                        pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        def record_sni(connection, name, _context):
            setattr(connection, "quixi_sni", name)
            with self.lock:
                if len(self.handshakes) < 512:
                    self.handshakes.append({"phase": self.phase, "sni": name})
        context.set_servername_callback(record_sni)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        try:
            self.verify_tls()
        except Exception:
            self.close()
            raise

    def verify_tls(self):
        context = ssl.create_default_context(cafile=str(self.ca))
        for name in dict.fromkeys([*HOSTS, "api.openai.com", "127.0.0.1", *self.certificate_hostnames]):
            accepted = False
            failure = None
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=5) as raw:
                    with context.wrap_socket(raw, server_hostname=name):
                        accepted = True
            except ssl.SSLCertVerificationError as error:
                failure = str(error)
            if accepted != (name in self.certificate_hostnames):
                raise RuntimeError(f"Ephemeral TLS fixture hostname validation failed for {name}: {failure}")
            self.tls_checks.append({"hostname": name, "accepted": accepted})

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--output", type=Path, default=HERE / "evidence/native-regional-app.json")
    args = parser.parse_args()
    if sys.platform != "darwin" or int(platform.mac_ver()[0].split(".")[0]) < 14:
        raise RuntimeError("This proof requires macOS 14+ and an isolated WKWebsiteDataStore UUID")
    report = {
        "status": "running", "startedAt": now(), "profile": str(uuid.uuid4()),
        "platform": platform.platform(), "macos": platform.mac_ver()[0],
        "systemWebKitVersion": plistlib.loads(Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").read_bytes())["CFBundleVersion"],
        "scope": "Actual isolated Tauri/WKWebView application workflows and unchanged production regional registrations, with feature-only DNS resolution to controlled HTTPS. Ephemeral CA and original US/EU TLS hostnames are validated. Synthetic credentials/content only; no physical-geography, live account eligibility, external provider or other native-platform claim.",
        "commands": [], "phases": [], "sourceSha256": {},
    }

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")

    def archive_existing():
        if args.output.exists():
            previous = args.output.read_bytes()
            folder = args.output.parent / "attempts"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{hashlib.sha256(previous).hexdigest()[:8]}.json").write_bytes(previous)

    archive_existing()
    save()
    sources = [
        "Cargo.lock", "package.json", "package-lock.json", ".github/workflows/check.yml", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/tauri.conf.json",
        "apps/desktop/src/host/index.ts", "apps/desktop/src/host/provider-connections.ts",
        "packages/core/src/contracts/host.ts", "packages/core/src/contracts/routing-aliases.ts", "packages/core/src/contracts/storage.ts",
        "packages/core/src/contracts/blob-inventory.ts",
        "packages/providers/src/adapter.ts", "packages/providers/src/request.ts", "packages/providers/src/generation.ts", "packages/providers/src/regional.ts", "packages/providers/src/catalog.ts", "packages/providers/src/types.ts",
        "packages/app/src/AppRoot.tsx", "packages/app/src/styles.css", "packages/app/src/index.ts", "packages/app/src/workflows/chat.ts",
        "packages/app/src/runtime/library.ts", "packages/app/src/runtime/routing.ts", "packages/app/src/runtime/processing-region.ts", "packages/app/src/runtime/request-cost.ts",
        "packages/app/src/features/providers/controller.ts", "packages/app/src/features/providers/types.ts", "packages/app/src/features/providers/ProviderSettingsPanel.tsx", "packages/app/src/features/providers/providers.css",
        "packages/app/src/features/compaction/summaries.ts", "packages/app/src/features/compaction/SummaryCompaction.tsx",
        *[str(path.relative_to(ROOT)) for path in sorted((ROOT / "packages/app/src/features/diagnostics").glob("*")) if path.is_file()],
        "packages/storage/src/worker/blob-inventory.ts", "packages/storage/src/worker/blobs.ts",
        "packages/storage/src/worker/canonical/repository.ts", "packages/storage/src/worker/archive-database.ts", "packages/storage/src/worker/archive-runtime.ts", "packages/storage/tests/isolated-client.ts", "packages/storage/tests/isolated-worker.ts",
        "packages/storage/sqlite/dist/sqlite3.wasm", "packages/storage/sqlite/dist/sqlite3.mjs",
        *[str(path.relative_to(ROOT)) for path in sorted((ROOT / "apps/desktop/src-tauri/src").rglob("*.rs"))],
        *[str(path.relative_to(ROOT)) for path in sorted(HERE.iterdir()) if path.is_file() and path.suffix in {".py", ".ts", ".rs", ".json", ".html", ".mjs"}],
    ]
    try:
        for source in sources:
            report["sourceSha256"][source] = digest(ROOT / source)
        stamp = HERE / "build/native-build.json"
        if not args.skip_build:
            for command in [
                ["node_modules/.bin/tsc", "--noEmit", "-p", "tests/hosts/regional-app-proof/tsconfig.json"],
                ["node", "tests/hosts/regional-app-proof/build.mjs"],
                ["cargo", "build", "--locked", "-p", "quixi-desktop", "--bin", "quixi-regional-app-proof", "--features", "regional-app-proof"],
            ]:
                started = now()
                result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600)
                report["commands"].append({"argv": command, "startedAt": started, "completedAt": now(), "exitCode": result.returncode, "stdout": result.stdout[-8192:], "stderr": result.stderr[-8192:]})
                save()
                if result.returncode:
                    raise RuntimeError("Native regional build command failed")
            stamp.write_text(json.dumps({"binarySha256": digest(BINARY), "sourceSha256": report["sourceSha256"]}, indent=2) + "\n")
        else:
            built = json.loads(stamp.read_text())
            if built["binarySha256"] != digest(BINARY) or built["sourceSha256"] != report["sourceSha256"]:
                raise RuntimeError("--skip-build requires the exact recorded binary and source snapshot")
        report["binarySha256"] = digest(BINARY)
        production = json.loads((ROOT / "apps/desktop/src-tauri/tauri.conf.json").read_text())
        proof = json.loads((HERE / "build/tauri.conf.json").read_text())
        if production["app"]["security"]["csp"] != proof["app"]["security"]["csp"]:
            raise RuntimeError("Native proof changed production CSP")
        report["configuredCsp"] = production["app"]["security"]["csp"]
        report["appIdentifier"] = proof["identifier"]
        report["bundledSha256"] = {str(path.relative_to(HERE / "build/dist")): digest(path) for path in sorted((HERE / "build/dist").rglob("*")) if path.is_file()}
        with tempfile.TemporaryDirectory(prefix="quixi-native-regional-tls-") as directory:
            fixture = RegionalTlsFixture(Path(directory))
            negative_directory = Path(directory) / "negative"
            negative_directory.mkdir()
            negative = None
            try:
                negative = RegionalTlsFixture(negative_directory, ["unrelated.invalid"])
                report["tlsFixture"] = {"listenAddress": "127.0.0.1", "port": fixture.port, "certificateSha256": fixture.certificate_sha256, "hostnameChecks": fixture.tls_checks}
                report["negativeTlsFixture"] = {"listenAddress": "127.0.0.1", "port": negative.port, "certificateSha256": negative.certificate_sha256, "hostnameChecks": negative.tls_checks}
                write_succeeded = False
                for phase in ["tls-untrusted-ca", "tls-wrong-hostname", "write", "restart", "cleanup"]:
                    if phase == "restart" and not write_succeeded:
                        continue
                    fixture.phase = phase
                    negative.phase = phase
                    active = negative if phase == "tls-wrong-hostname" else fixture
                    trusted_ca = negative.ca if phase in {"tls-untrusted-ca", "tls-wrong-hostname"} else fixture.ca
                    start_requests = len(fixture.requests)
                    start_negative_requests = len(negative.requests)
                    start_handshakes = len(active.handshakes)
                    env = {**os.environ, "QUIXI_REGIONAL_APP_PROFILE": report["profile"], "QUIXI_REGIONAL_APP_PHASE": phase, "QUIXI_REGIONAL_APP_TLS_PORT": str(active.port), "QUIXI_REGIONAL_APP_TLS_CA": str(trusted_ca)}
                    # Prevent ambient proxy settings from redirecting synthetic credentials.
                    env = {key: value for key, value in env.items() if key.lower() not in {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}}
                    entry = {"phase": phase, "startedAt": now()}
                    try:
                        result = subprocess.run([str(BINARY)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=255)
                        entry.update({"exitCode": result.returncode, "stderr": result.stderr[-16384:]})
                        lines = result.stdout.splitlines()
                        reports = [line.split("=", 1)[1] for line in lines if line.startswith("QUIXI_REGIONAL_APP_PROOF=")]
                        checkpoints = [line.split("=", 1)[1] for line in lines if line.startswith("QUIXI_REGIONAL_APP_CHECKPOINT=")]
                        entry["checkpoints"] = [json.loads(value) for value in checkpoints[-32:] if len(value) <= 65536]
                        if len(reports) != 1 or len(reports[0]) > 262144:
                            raise RuntimeError("Native WebView did not return exactly one bounded proof report")
                        native = json.loads(reports[0])
                        entry["native"] = native
                        if native["profile"] != report["profile"] or native["phase"] != phase or native["configuredCsp"] != report["configuredCsp"]:
                            raise RuntimeError("Native phase changed its isolated profile or production CSP")
                        if native.get("keychainService") != "ai.quixi.chat.regional-app-proof." + report["profile"]:
                            raise RuntimeError("Native phase did not use its isolated Keychain service")
                        if native.get("tlsFixture") != {"address": "127.0.0.1:" + str(active.port), "hosts": ["us.api.openai.com", "eu.api.openai.com"], "hostnameValidation": True}:
                            raise RuntimeError("Native phase changed the verified TLS fixture binding")
                        entry["success"] = result.returncode == 0 and native["webview"].get("success") is True
                    except subprocess.TimeoutExpired:
                        entry.update({"success": False, "error": "Native process exceeded its bounded phase deadline"})
                    except Exception as error:
                        entry.update({"success": False, "error": str(error)})
                    entry["tlsRequests"] = fixture.requests[start_requests:] + negative.requests[start_negative_requests:]
                    entry["tlsHandshakes"] = active.handshakes[start_handshakes:]
                    if phase.startswith("tls-") and (entry["tlsRequests"] or not any(item["sni"] == "us.api.openai.com" for item in entry["tlsHandshakes"])):
                        entry.update({"success": False, "tlsNegativeError": "Expected an actual US TLS handshake refusal with zero HTTP requests"})
                    counts = {region: {"models": 0, "content": 0} for region in ["us", "eu", "global"]}
                    for request in entry["tlsRequests"]:
                        counts[request["region"] or "global"]["models" if request["path"] == "/v1/models" else "content"] += 1
                    entry["observedWireCounts"] = counts
                    expected = entry.get("native", {}).get("webview", {}).get("expectedWireCounts")
                    if expected != counts:
                        entry.update({"success": False, "wireCountError": "Frontend expected wire counts differ from actual TLS requests"})
                    required_counts = {"us": {"models": 1, "content": 5}, "eu": {"models": 1, "content": 1}, "global": {"models": 0, "content": 0}} if phase == "write" else {region: {"models": 0, "content": 0} for region in ["us", "eu", "global"]}
                    if counts != required_counts:
                        entry.update({"success": False, "scenarioCountError": "Actual TLS counts differ from the required bounded native scenarios"})
                    entry["completedAt"] = now()
                    report["phases"].append(entry)
                    save()
                    if phase == "write":
                        write_succeeded = entry.get("success") is True
                    print(f"native regional {phase}: {'passed' if entry.get('success') else 'failed'}", flush=True)
                report["tlsRequests"] = fixture.requests
                report["negativeTlsRequests"] = negative.requests
                report["fixtureErrors"] = fixture.errors + negative.errors
                if report["fixtureErrors"]:
                    raise RuntimeError("TLS fixture observed invalid native traffic")
                if len(report["phases"]) != 5 or not all(phase.get("success") for phase in report["phases"]):
                    raise RuntimeError("Native TLS negatives, write, restart and cleanup must all pass")
                if any(request["phase"] != "write" for request in fixture.requests):
                    raise RuntimeError("Restart or cleanup unexpectedly dispatched provider traffic")
                if not any(request["path"] == "/v1/chat/completions" and request["status"] == 200 for request in fixture.requests):
                    raise RuntimeError("No successful actual regional TLS content request was observed")
                written = next(phase["native"]["webview"] for phase in report["phases"] if phase["phase"] == "write")
                restarted = next(phase["native"]["webview"] for phase in report["phases"] if phase["phase"] == "restart")
                fingerprint = written.get("canonical", {}).get("canonicalSha256")
                if not isinstance(fingerprint, str) or len(fingerprint) != 64 or restarted.get("canonical", {}).get("canonicalSha256") != fingerprint:
                    raise RuntimeError("Canonical fingerprint changed across native process restart")
                report["canonicalRestartExact"] = True
                summary_hash = written.get("canonical", {}).get("summary", {}).get("verifiedSavedInputSha256")
                matching_summary = [request for request in fixture.requests if request["method"] == "POST" and request.get("status") == 200 and request["bodySha256"] == summary_hash]
                if len(matching_summary) != 1:
                    raise RuntimeError("Saved summary input hash must match exactly one actual successful TLS request")
                report["summaryWireExact"] = {"inputSha256": summary_hash, "requestSequence": matching_summary[0]["sequence"]}
                report["status"] = "passed"
            finally:
                if negative:
                    negative.close()
                fixture.close()
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
    finally:
        report["changedSources"] = [source for source, value in report["sourceSha256"].items() if not (ROOT / source).is_file() or digest(ROOT / source) != value]
        report["sourceStable"] = not report["changedSources"]
        if not report["sourceStable"]:
            report["status"] = "failed"
        report["completedAt"] = now()
        save()
        folder = args.output.parent / "attempts"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{report['profile']}.json").write_bytes(args.output.read_bytes())
    print(json.dumps({"status": report["status"], "profile": report["profile"], "output": str(args.output)}, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
