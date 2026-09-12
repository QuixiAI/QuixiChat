#!/usr/bin/env python3
"""Convert raw WASM typed-array exports to the common NPZ comparison format."""
import argparse
import copy
import json
from pathlib import Path
import numpy as np
from fetch import ROOT, sha256


def convert(source, output, golden_dir=ROOT / 'tests/goldens'):
    manifest = json.loads((source / 'manifest.json').read_text())
    golden = json.loads((golden_dir / 'manifest.json').read_text())
    if len(manifest['cases']) != len(golden['cases']):
        raise ValueError('WASM run has not completed every case')
    output.mkdir(parents=True, exist_ok=True)
    result = copy.deepcopy(manifest)
    for case in result['cases']:
        path = source / case['file']
        if sha256(path) != case['sha256']:
            raise ValueError('WASM raw array hash mismatch')
        raw = path.read_bytes();arrays = {}
        for name, metadata in case.pop('raw_arrays').items():
            value = np.frombuffer(raw, dtype='<u4' if metadata['dtype'] == 'uint32' else '<f4',
                                  count=metadata['bytes'] // 4, offset=metadata['offset']).reshape(metadata['shape'])
            arrays[name] = value.astype(np.int64) if metadata['dtype'] == 'uint32' else value
        case['file'] = case['id'] + '.npz'
        path = output / case['file'];np.savez_compressed(path, **arrays);case['sha256'] = sha256(path)
    (output / 'manifest.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(f'Converted {len(result["cases"])} complete WASM cases')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'build/wasm-raw')
    parser.add_argument('--output', type=Path, default=ROOT / 'build/wasm-goldens')
    parser.add_argument('--goldens', type=Path, default=ROOT / 'tests/goldens')
    args = parser.parse_args();convert(args.source, args.output, args.goldens)
