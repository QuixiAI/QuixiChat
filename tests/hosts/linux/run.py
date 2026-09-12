#!/usr/bin/env python3
"""Stage minimal inputs and validate actual Linux Tauri under Xvfb in Docker."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
IMAGE = "quixi-tauri-linux-proof:rust-1.97.1-bookworm"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-image-build", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/tauri-linux-proof.json")
    args = parser.parse_args()
    if not args.skip_image_build:
        subprocess.run(["docker", "build", "-t", IMAGE, str(Path(__file__).parent)], check=True)
    with tempfile.TemporaryDirectory(prefix="quixi-linux-proof-") as temporary:
        stage = Path(temporary)
        files = ["Cargo.toml", "Cargo.lock", "apps/desktop/src-tauri/Cargo.toml",
                 "apps/desktop/src-tauri/build.rs", "apps/desktop/src-tauri/tauri.conf.json",
                 "tests/hosts/tauri-storage-proof.js", "tests/hosts/run_tauri_storage_proof.py",
                 "tests/hosts/linux/inside.py", "tests/hosts/linux/origin_diagnostics.py",
                 "tests/hosts/linux/features.c", "tests/hosts/linux/enable_storage_features.c",
                 "tests/hosts/linux/capabilities-worker.js",
                 "packages/storage/sqlite/dist/sqlite3.wasm"]
        for relative in files:
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, destination)
        for relative in ["apps/desktop/src-tauri/src", "apps/desktop/src-tauri/icons", "apps/desktop/dist"]:
            shutil.copytree(ROOT / relative, stage / relative)
        command = ["docker", "run", "--rm", "--shm-size=512m",
                   "--mount", f"type=bind,src={stage},dst=/input,readonly",
                   "--mount", "type=volume,src=quixi-linux-tauri-target,dst=/work/target",
                   "--mount", "type=volume,src=quixi-linux-tauri-registry,dst=/usr/local/cargo/registry",
                   "--mount", "type=volume,src=quixi-linux-tauri-git,dst=/usr/local/cargo/git",
                   IMAGE, "python3", "/input/tests/hosts/linux/inside.py"]
        run = subprocess.run(command, capture_output=True, text=True)
        print(run.stderr[-16000:], file=sys.stderr)
        lines = [line.split("=", 1)[1] for line in run.stdout.splitlines() if line.startswith("QUIXI_LINUX_PROOF=")]
        if not lines:
            print(run.stdout[-12000:], file=sys.stderr)
            raise RuntimeError("Linux container did not emit a proof report")
        report = json.loads(lines[-1])
        report["imageId"] = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE], text=True).strip()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print(f"Linux Tauri proof: success={report['success']}; evidence={args.output}")
        return run.returncode


if __name__ == "__main__":
    sys.exit(main())
