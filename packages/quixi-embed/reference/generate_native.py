#!/usr/bin/env python3
"""Run every frozen case through the actual C scalar API and export comparison arrays."""
import argparse
import copy
import json
from pathlib import Path
import time
import numpy as np
from fetch import ROOT, sha256
from native_runtime import Native, DEFAULT_LIBRARY


def generate(output, model=None, library=None, resume=False):
    library = Path(library or DEFAULT_LIBRARY)
    model = Path(model or ROOT / 'build/arctic-xs.qxmodel')
    identity = {'route': 'native-c-scalar-fp32', 'library_sha256': sha256(library), 'model_sha256': sha256(model)}
    golden = json.loads((ROOT / 'tests/goldens/manifest.json').read_text())
    output.mkdir(parents=True, exist_ok=True)
    target = output / 'manifest.json'
    result = {'version': 1, 'source': golden['source'], 'backend': identity, 'cases': []}
    completed = {}
    if resume and target.exists():
        previous = json.loads(target.read_text())
        if previous['backend'] != identity:
            raise ValueError('Cannot resume outputs from a different native artifact')
        completed = {case['id']: case for case in previous['cases']}
    native = Native(model, library)
    begin = time.perf_counter()
    try:
        for index, case in enumerate(golden['cases']):
            path = output / case['file']
            old = completed.get(case['id'])
            if old and old['texts'] == case['texts'] and old['role'] == case['role'] and path.exists() and sha256(path) == old['sha256']:
                result['cases'].append(old)
                continue
            arrays = native.forward(case['texts'], case['role'], case['stages'])
            np.savez_compressed(path, **arrays)
            entry = copy.deepcopy(case);entry['sha256'] = sha256(path)
            result['cases'].append(entry)
            target.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
            if index % 5 == 0 or index + 1 == len(golden['cases']):
                print(f'{index + 1}/{len(golden["cases"])} {case["id"]} elapsed={time.perf_counter()-begin:.1f}s', flush=True)
        result['workspace_bytes'] = native.library.qx_workspace_bytes(native.workspace)
        result['model_bytes'] = native.library.qx_model_bytes(native.model)
        result['elapsed_seconds'] = time.perf_counter() - begin
        target.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    finally:
        native.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/native-goldens')
    parser.add_argument('--library', type=Path)
    parser.add_argument('--model', type=Path)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args();generate(args.output, args.model, args.library, args.resume)
