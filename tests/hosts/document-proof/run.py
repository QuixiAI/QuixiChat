#!/usr/bin/env python3
"""Qualify bundled macOS PDF workers in a mandatory isolated WKWebView UUID store."""
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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
EVIDENCE = HERE / "evidence"
BINARY = ROOT / "target/debug/quixi-document-proof"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--output", type=Path, default=EVIDENCE / "native-pdf.json")
    args = parser.parse_args()
    if sys.platform != "darwin" or int(platform.mac_ver()[0].split(".")[0]) < 14:
        raise RuntimeError("This proof requires macOS 14+ for an isolated WKWebsiteDataStore UUID")
    report = {
        "status": "running", "startedAt": now(), "profile": str(uuid.uuid4()),
        "platform": platform.platform(), "macos": platform.mac_ver()[0],
        "systemWebKitVersion": plistlib.loads(Path("/System/Library/Frameworks/WebKit.framework/Resources/Info.plist").read_bytes())["CFBundleVersion"],
        "buildProfile": "dev, custom-protocol, feature-gated synthetic binary",
        "evidenceScope": "Bundled native WKWebView functional PDF/storage/CSP qualification. No quiescent performance or other native WebView family claim.",
        "commands": [], "phases": [], "sourceSha256": {},
    }

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")

    if args.output.exists():
        previous = args.output.read_bytes()
        archive = args.output.parent / "attempts"
        archive.mkdir(parents=True, exist_ok=True)
        (archive / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{hashlib.sha256(previous).hexdigest()[:8]}.json").write_bytes(previous)
    save()
    sources = [
        "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/tauri.conf.json", "Cargo.lock", "package-lock.json",
        "packages/documents/src/index.ts", "packages/documents/src/contracts.ts", "packages/documents/src/storage-source.ts",
        "packages/documents/src/layout.ts", "packages/core/src/contracts/extraction.ts",
        "packages/documents/src/persist.ts", "packages/documents/src/persist-mutation.ts",
        "packages/documents/src/worker/index.ts", "packages/documents/src/worker/parser.ts", "packages/documents/src/worker/assets.ts",
        "packages/documents/tooling/pdfjs-range-patch.mjs",
        "packages/documents/tests/fixtures/manifest.json", "packages/storage/src/worker/archive-database.ts",
        "packages/documents/tests/fixtures/layout-manifest.json", "packages/documents/tests/layout-fixtures.md",
        "packages/documents/tests/fixtures/layout-columns.pdf", "packages/documents/tests/fixtures/layout-unsupported.pdf",
        "packages/storage/src/worker/archive-runtime.ts", "packages/storage/src/client/archive.ts", "packages/storage/src/client/selection.ts",
        "packages/storage/src/worker/sqlite-module.ts", "packages/storage/src/worker/extraction/index.ts",
        "packages/storage/src/worker/extraction/schema.ts", "packages/storage/src/worker/operation-claims.ts",
        "packages/storage/sqlite/dist/sqlite3.wasm", "packages/storage/sqlite/dist/sqlite3.mjs",
        "node_modules/pdfjs-dist/build/pdf.mjs", "node_modules/pdfjs-dist/build/pdf.worker.mjs", "node_modules/pdfjs-dist/package.json",
        *[str(path.relative_to(ROOT)) for path in sorted(HERE.iterdir()) if path.is_file()],
    ]
    try:
        for source in sources:
            report["sourceSha256"][source] = digest(ROOT / source)
        stamp = HERE / "build/native-build.json"
        if not args.skip_build:
            for command in [
                ["node_modules/.bin/tsc", "--noEmit", "-p", "tests/hosts/document-proof/tsconfig.json"],
                ["node", "tests/hosts/document-proof/build.mjs"],
                ["cargo", "build", "-p", "quixi-desktop", "--bin", "quixi-document-proof", "--features", "document-proof,custom-protocol"],
            ]:
                started = now()
                run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=600)
                report["commands"].append({"argv": command, "startedAt": started, "completedAt": now(), "exitCode": run.returncode, "stdout": run.stdout[-8192:], "stderr": run.stderr[-8192:]})
                save()
                if run.returncode:
                    raise RuntimeError(f"Build command failed: {command}")
            stamp.write_text(json.dumps({"binarySha256": digest(BINARY), "sourceSha256": report["sourceSha256"]}, indent=2) + "\n")
        else:
            built = json.loads(stamp.read_text())
            if built["binarySha256"] != digest(BINARY) or any(built["sourceSha256"].get(name) != value for name, value in report["sourceSha256"].items()):
                raise RuntimeError("--skip-build requires the exact recorded binary/source snapshot")
        report["binarySha256"] = digest(BINARY)
        production = json.loads((ROOT / "apps/desktop/src-tauri/tauri.conf.json").read_text())
        proof = json.loads((HERE / "build/tauri.conf.json").read_text())
        if production["app"]["security"]["csp"] != proof["app"]["security"]["csp"]:
            raise RuntimeError("Proof changed production CSP")
        report["configuredCsp"] = production["app"]["security"]["csp"]
        report["appIdentifier"] = proof["identifier"]
        report["bundledSha256"] = {str(path.relative_to(HERE / "build/dist")): digest(path) for path in sorted((HERE / "build/dist").rglob("*")) if path.is_file()}
        wasm = [value for name, value in report["bundledSha256"].items() if name.endswith(".wasm") and "sqlite3-" in name]
        if wasm != [digest(ROOT / "packages/storage/sqlite/dist/sqlite3.wasm")]:
            raise RuntimeError("Bundled SQLite WASM differs from the pinned artifact")
        upstream = {digest(path) for folder in ["cmaps", "standard_fonts"] for path in (ROOT / "node_modules/pdfjs-dist" / folder).iterdir() if path.is_file()}
        supplemental = {name: value for name, value in report["bundledSha256"].items() if name.endswith((".pfb", ".ttf", ".bcmap"))}
        if not supplemental or not all(value in upstream for value in supplemental.values()):
            raise RuntimeError("Bundled PDF supplemental assets differ from the pinned package")
        report["pinnedSupplementalAssetCount"] = len(supplemental)
        write_succeeded = False
        # Cleanup always uses the SAME proof UUID, even after failed qualification.
        for phase in ["write", "restart", "cleanup"]:
            if phase == "restart" and not write_succeeded:
                continue
            env = {**os.environ, "QUIXI_DOCUMENT_PROOF_PROFILE": report["profile"], "QUIXI_DOCUMENT_PROOF_PHASE": phase}
            entry = {"phase": phase, "startedAt": now()}
            try:
                run = subprocess.run([str(BINARY)], cwd=ROOT, env=env, capture_output=True, text=True, timeout=255)
                entry.update({"exitCode": run.returncode, "stdout": run.stdout[-4096:], "stderr": run.stderr[-16384:]})
                lines = [line.split("=", 1)[1] for line in run.stdout.splitlines() if line.startswith("QUIXI_DOCUMENT_PROOF=")]
                if lines:
                    native = json.loads(lines[-1]); entry["native"] = native
                    if native["profile"] != report["profile"] or native["phase"] != phase or native["configuredCsp"] != report["configuredCsp"]:
                        raise RuntimeError("Native phase changed its isolated profile or production CSP")
                    entry["success"] = run.returncode == 0 and native["webview"].get("success") is True
                else:
                    entry["success"] = False; entry["error"] = "Native WebView did not return a bounded proof report"
            except subprocess.TimeoutExpired as error:
                entry.update({"success": False, "error": "Native process exceeded its bounded phase deadline", "stdout": str(error.stdout or "")[-4096:], "stderr": str(error.stderr or "")[-8192:]})
            except Exception as error:
                entry.update({"success": False, "error": str(error)})
            entry["completedAt"] = now(); report["phases"].append(entry); save()
            if phase == "write": write_succeeded = entry.get("success") is True
            print(f"native PDF {phase}: {'passed' if entry.get('success') else 'failed'}", flush=True)
        phases_ok = len(report["phases"]) == 3 and all(phase.get("success") for phase in report["phases"])
        if phases_ok:
            written = report["phases"][0]["native"]["webview"]
            restarted = report["phases"][1]["native"]["webview"]
            if len(written.get("layoutPages", [])) != 2 or written["layoutPages"] != restarted.get("layoutPages"):
                raise RuntimeError("Layout publication identity, text hash or metadata changed across native process restart")
            if written.get("normalizerVersion") != "quixi-layout-2" or restarted.get("normalizerVersion") != "quixi-layout-2":
                raise RuntimeError("Native layout qualification requires quixi-layout-2")
            report["layoutRestartExact"] = True
            resources = report["phases"][0]["native"]["resources"]
            fonts = [resource for resource in resources if resource["url"].split("?")[0].endswith((".pfb", ".ttf"))]
            report["observedBundledFonts"] = fonts
            if not fonts or any(resource["status"] != 200 for resource in fonts):
                raise RuntimeError("No successful real bundled font fetch was observed")
            if not any(resource.get("csp") for resource in resources):
                raise RuntimeError("No effective bundled HTML CSP header was observed")
        report["status"] = "passed" if phases_ok else "failed"
    except Exception as error:
        report["status"] = "failed"; report["error"] = str(error)
    finally:
        report["changedSources"] = [source for source, value in report["sourceSha256"].items() if not (ROOT / source).is_file() or digest(ROOT / source) != value]
        report["sourceStable"] = not report["changedSources"]
        if not report["sourceStable"]:
            report["status"] = "failed"
            report["snapshotError"] = "Source changes during capture prevent qualification of one recorded snapshot"
        report["completedAt"] = now(); save()
    print(json.dumps({"status": report["status"], "profile": report["profile"], "output": str(args.output)}, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
