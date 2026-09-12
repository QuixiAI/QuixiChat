#!/usr/bin/env python3
"""Generate tokenizer, complete selected hidden-state, and route-matrix goldens."""
import argparse
import json
from pathlib import Path
import numpy as np
from safetensors import safe_open
from cases import cases, BATCHES, LENGTHS, ROUTES
from fetch import ROOT, sha256
from runtime import Reference, environment


def generate(output, source=None):
    reference = Reference(source)
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'version': 1, 'source': reference.lock, 'environment': environment(),
                'coverage': {'batches': BATCHES, 'lengths': LENGTHS, 'intended_routes': ROUTES},
                'cases': []}
    for case in cases():
        result = reference.forward(case['texts'], case['role'], case['stages'])
        if 'expected_shape' in case:
            assert list(result['input_ids'].shape) == case['expected_shape'], case['id']
        path = output / f"{case['id']}.npz"
        np.savez_compressed(path, **result)
        manifest['cases'].append({**case, 'file': path.name, 'sha256': sha256(path),
                                  'arrays': {name: {'shape': list(array.shape), 'dtype': str(array.dtype)}
                                             for name, array in result.items()}})
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    tensors = []
    with safe_open(reference.source / 'model.safetensors', framework='numpy') as handle:
        for name in sorted(handle.keys()):
            tensor = handle.get_tensor(name)
            tensors.append({'name': name, 'shape': list(tensor.shape), 'dtype': str(tensor.dtype),
                            'elements': int(tensor.size), 'sha256': __import__('hashlib').sha256(tensor.tobytes()).hexdigest()})
    inventory = {'checkpoint_sha256': reference.lock['files']['model.safetensors']['sha256'],
                 'tensor_count': len(tensors), 'parameters': sum(t['elements'] for t in tensors), 'tensors': tensors}
    (output / 'tensor-inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    print(f"Generated {len(manifest['cases'])} cases and {len(tensors)}-tensor inventory in {output}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'tests/goldens')
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    generate(args.output, args.source)
