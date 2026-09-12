#!/usr/bin/env python3
"""Download only the frozen public artifacts, verifying size and SHA-256."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'reference/source-lock.json'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify(directory):
    lock = json.loads(LOCK.read_text())
    for name, expected in lock['files'].items():
        path = directory / name
        if not path.is_file() or path.stat().st_size != expected['bytes'] or sha256(path) != expected['sha256']:
            raise ValueError(f'Frozen source integrity failure: {name}')
    return lock


def fetch(directory):
    lock = json.loads(LOCK.read_text())
    for name, expected in lock['files'].items():
        path = directory / name
        if path.is_file() and path.stat().st_size == expected['bytes'] and sha256(path) == expected['sha256']:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + '.part')
        url = f"https://huggingface.co/{lock['repository']}/resolve/{lock['revision']}/{name}"
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b''):
                output.write(chunk)
        if temporary.stat().st_size != expected['bytes'] or sha256(temporary) != expected['sha256']:
            temporary.unlink()
            raise ValueError(f'Download integrity failure: {name}')
        temporary.replace(path)
    verify(directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'build/source')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    (verify if args.verify_only else fetch)(args.source)
    print('Verified all frozen Arctic XS artifacts.')
