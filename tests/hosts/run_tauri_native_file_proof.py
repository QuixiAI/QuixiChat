#!/usr/bin/env python3
"""Actual Tauri disk staging/import/export with isolated 256 MiB fixture files."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
ROOT = Path(__file__).resolve().parents[2]

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--output', type=Path, default=ROOT / 'test-results/tauri-native-files.json')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='quixi-native-file-proof-') as temporary:
        directory = Path(temporary)
        chunk = bytes(range(256)) * 256
        with (directory / 'input.bin').open('wb') as file:
            for _ in range(4096):
                file.write(chunk)
        (directory / 'preserved.bin').write_bytes(b'synthetic existing destination must survive cancellation')
        before = digest(directory / 'preserved.bin')
        expected = digest(directory / 'input.bin')
        result_file = directory / 'native-result.json'
        env = {**os.environ, 'QUIXI_HOST_FILE_PROOF_DIR': str(directory), 'QUIXI_HOST_FILE_PROOF_SHA256': expected}
        command = ['python3', 'tests/hosts/run_tauri_native_host_proof.py', '--output', str(result_file)]
        if args.skip_build:
            command.append('--skip-build')
        samples = []
        done = threading.Event()
        def sample():
            while not done.wait(0.05):
                result = subprocess.run(['ps', '-axo', 'pid=,rss=,comm='], capture_output=True, text=True, check=True)
                for line in result.stdout.splitlines():
                    fields = line.strip().split(None, 2)
                    if len(fields) == 3 and fields[2] == str(ROOT / 'target/debug/quixi-desktop'):
                        samples.append({'pid': int(fields[0]), 'rssBytes': int(fields[1]) * 1024})
        observer = threading.Thread(target=sample, daemon=True); observer.start()
        try:
            run = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=300)
        finally:
            done.set(); observer.join()
        host = json.loads(result_file.read_text()) if result_file.exists() else {'success':False, 'stderr':run.stderr[-4096:], 'stdout':run.stdout[-4096:]}
        checks = {
            'exportDigestMatches256MiBInput': (directory/'export.bin').exists() and digest(directory/'export.bin') == expected,
            'cancelledCopyPreservedExistingDestination': digest(directory/'preserved.bin') == before,
            'cancelledSelectionCreatedNoFile': not (directory/'cancel.bin').exists(),
            'siblingTemporaryFilesCleaned': not list(directory.glob('.quixi-export-*')),
        }
        write_pid = samples[0]['pid'] if samples else None
        write_samples = [sample['rssBytes'] for sample in samples if sample['pid'] == write_pid]
        memory = {'nativeProcessSamples': len(write_samples), 'nativeInitialRssBytes': write_samples[0] if write_samples else None, 'nativePeakRssBytes': max(write_samples) if write_samples else None, 'scope': 'OS ps RSS of native process only; WebKit GPU/content process heap is not measured'}
        if write_samples:
            memory['nativeRssGrowthBytes'] = max(write_samples)-write_samples[0]
            checks['nativeRssGrowthBelow256MiBFileSize'] = memory['nativeRssGrowthBytes'] < 268435456
        result = {'timestamp':datetime.now(timezone.utc).isoformat(),'host':host,'fixtureBytes':268435456,'fixtureSha256':expected,'selection':'feature-only programmatic native dialog result, no user selection automation claimed','filesystemChecks':checks,'memory':memory,'success':run.returncode==0 and host.get('success') and all(checks.values())}
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,indent=2))
        return 0 if result['success'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
