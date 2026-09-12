#!/usr/bin/env python3
"""Fetch verified sources and build the one canonical SQLite artifact in Docker."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--prepare-only", action="store_true", help="Fetch and unpack verified sources without launching Docker (for the pinned SDK build stage)")
options = parser.parse_args()
manifest = json.loads((ROOT / "sources.json").read_text())
build = ROOT / "build"
downloads = build / "downloads"
downloads.mkdir(parents=True, exist_ok=True)

for source in manifest["sources"]:
    archive = downloads / source["file"]
    if not archive.exists():
        temporary = archive.with_suffix(archive.suffix + ".partial")
        subprocess.run(["curl", "-fL", "--retry", "3", source["url"], "-o", str(temporary)], check=True)
        temporary.replace(archive)
    payload = archive.read_bytes()
    if hashlib.sha256(payload).hexdigest() != source["sha256"]:
        raise SystemExit(f"Source SHA256 mismatch: {archive}; remove it and retry")
    if "upstreamSha3_256" in source and hashlib.sha3_256(payload).hexdigest() != source["upstreamSha3_256"]:
        raise SystemExit(f"Source upstream SHA3-256 mismatch: {archive}")
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as bundle:
            # Hash-verified archives, with paths still restricted to the build dir.
            for item in bundle.infolist():
                target = (build / item.filename).resolve()
                if not target.is_relative_to(build.resolve()):
                    raise SystemExit("Archive path escapes build directory")
            top = build / bundle.namelist()[0].split("/")[0]
            if top.exists():
                shutil.rmtree(top)
            bundle.extractall(build)
            for item in bundle.infolist():
                mode = (item.external_attr >> 16) & 0o777
                if mode:
                    (build / item.filename).chmod(mode)
    else:
        destination = build / source["extractSubdirectory"]
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(destination, filter="data")

if options.prepare_only:
    print(f"Prepared verified SQLite sources in {build}")
    raise SystemExit(0)

toolchain = manifest["toolchain"]
command = ["docker", "run", "--rm", "--platform", toolchain["platform"],
           "--mount", f"type=bind,source={ROOT},target=/src", toolchain["image"],
           "bash", "/src/build-container.sh"]
with (build / "build.log").open("w") as output:
    result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
if result.returncode:
    print((build / "build.log").read_text()[-10000:])
    raise SystemExit(result.returncode)
subprocess.run(["node", str(ROOT / "verify.mjs")], check=True)
print(f"Built and verified pinned SQLite distribution in {ROOT / 'dist'}")
