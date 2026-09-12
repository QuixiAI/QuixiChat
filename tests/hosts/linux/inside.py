#!/usr/bin/env python3
"""Container-only build and real Tauri/WebKitGTK execution."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import origin_diagnostics


def capture(args):
    return subprocess.check_output(args, text=True).strip()


def main():
    shutil.copytree("/input", "/work", dirs_exist_ok=True)
    Path("/work").chmod(0o755)
    shutil.copy2("/input/tests/hosts/linux/capabilities-worker.js", "/work/apps/desktop/dist/linux-capabilities-worker.js")
    origin_diagnostics.instrument()
    evidence = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "host": "linux-tauri-webkitgtk-container",
        "platform": platform.platform(),
        "osRelease": Path("/etc/os-release").read_text(),
        "webkitgtkVersion": capture(["pkg-config", "--modversion", "webkit2gtk-4.1"]),
        "gtkVersion": capture(["pkg-config", "--modversion", "gtk+-3.0"]),
        "rustVersion": capture(["rustc", "--version"]),
        "packages": capture(["dpkg-query", "-W", "libwebkit2gtk-4.1-0", "xvfb", "libgtk-3-0"]),
        "display": "Xvfb", "softwareRendering": True,
        "webkitSandboxDisabled": False,
        "buildCommand": ["cargo", "build", "--locked", "-p", "quixi-desktop", "--features", "storage-proof"],
        "inputSha256": {str(p.relative_to('/input')): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in sorted(Path('/input').rglob('*')) if p.is_file()},
        "storageSupport": "unverified", "success": False,
    }
    flags = capture(["pkg-config", "--cflags", "--libs", "webkit2gtk-4.1"]).split()
    subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", "tests/hosts/linux/features.c", "-o", "/tmp/quixi-webkit-features", *flags], cwd="/work", check=True)
    subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "tests/hosts/linux/enable_storage_features.c", "-o", "/tmp/quixi-enable-storage.so", *flags, "-ldl"], cwd="/work", check=True)
    evidence["installedFeatureSettings"] = json.loads(capture(["runuser", "-u", "quixi", "--", "xvfb-run", "-a", "/tmp/quixi-webkit-features"]))
    evidence["testOnlyInstrumentation"] = "Container copy of Tauri proof includes an environment-gated readonly origin-capability callback; normal proof behavior is unchanged."
    evidence["instrumentedNativeSourceSha256"] = hashlib.sha256(Path("/work/apps/desktop/src-tauri/src/storage_proof.rs").read_bytes()).hexdigest()
    build = subprocess.run(evidence["buildCommand"], cwd="/work", capture_output=True, text=True)
    print(build.stderr[-12000:], file=sys.stderr)
    evidence["buildExitCode"] = build.returncode
    if build.returncode:
        evidence["buildErrorTail"] = build.stderr[-12000:]
    else:
        command = ["runuser", "-u", "quixi", "--", "dbus-run-session", "--", "xvfb-run", "-a",
                   "python3", "tests/hosts/run_tauri_storage_proof.py", "--skip-build", "--output", "/tmp/quixi-linux-proof.json"]
        try:
            run = subprocess.run(command, cwd="/work", capture_output=True, text=True, timeout=240)
            evidence["executionExitCode"] = run.returncode
            evidence["executionStderr"] = run.stderr[-12000:]
        except subprocess.TimeoutExpired:
            run = None
            evidence["executionError"] = "Linux host proof exceeded 240 seconds"
        result_path = Path("/tmp/quixi-linux-proof.json")
        if result_path.exists():
            evidence["proof"] = json.loads(result_path.read_text())
            evidence["success"] = evidence["proof"].get("success", False)
            evidence["storageSupport"] = "tested" if evidence["success"] else "failed-proof"
        elif run is not None:
            evidence["executionStdoutTail"] = run.stdout[-12000:]
        evidence["originDiagnostics"] = origin_diagnostics.run()
        command = ["runuser", "-u", "quixi", "--", "env", "LD_PRELOAD=/tmp/quixi-enable-storage.so",
                   "dbus-run-session", "--", "xvfb-run", "-a", "python3", "tests/hosts/run_tauri_storage_proof.py",
                   "--skip-build", "--output", "/tmp/quixi-linux-features-proof.json"]
        run = subprocess.run(command, cwd="/work", capture_output=True, text=True, timeout=240)
        evidence["featureSettingsExperiment"] = {
            "description": "Test-only interposition enables AccessHandle, FileSystem, FileSystemWritableStream, StorageAPI, StorageAPIEstimate via the public settings API in actual Tauri WebViews. No production host source is changed.",
            "exitCode": run.returncode, "stderr": run.stderr[-12000:],
        }
        path = Path("/tmp/quixi-linux-features-proof.json")
        if path.exists():
            evidence["featureSettingsExperiment"]["proof"] = json.loads(path.read_text())
        else:
            evidence["featureSettingsExperiment"]["stdoutTail"] = run.stdout[-12000:]
        evidence["featureSettingsExperiment"]["originDiagnostics"] = origin_diagnostics.run(enable_features=True)
    print("QUIXI_LINUX_PROOF=" + json.dumps(evidence))
    return 0 if evidence["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
