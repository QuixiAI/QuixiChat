#!/usr/bin/env python3
"""Fail closed on missing routes/cases, token mismatch, nonfinite values, or numeric drift."""
import argparse
import json
from pathlib import Path
import numpy as np
from fetch import ROOT, sha256

THRESHOLDS = {
    'scalar-fp32': {'atol': 1e-4, 'rtol': 1e-4, 'vector_atol': 2e-5, 'min_cosine': 0.999999, 'norm_atol': 1e-5},
    'wasm-simd-fp32': {'atol': 2e-4, 'rtol': 2e-4, 'vector_atol': 5e-5, 'min_cosine': 0.999999, 'norm_atol': 2e-5},
    'webgpu-fp32': {'atol': 3e-4, 'rtol': 3e-4, 'vector_atol': 8e-5, 'min_cosine': 0.999999, 'norm_atol': 3e-5},
    'webgpu-fp16': {'atol': 3e-2, 'rtol': 2e-2, 'vector_atol': 3e-3, 'min_cosine': 0.9999, 'norm_atol': 1e-3},
}


def compare(expected_dir, actual_dir, route):
    expected = json.loads((expected_dir / 'manifest.json').read_text())
    actual = json.loads((actual_dir / 'manifest.json').read_text())
    if expected['source'] != actual['source']:
        raise ValueError('source identity differs')
    ids = [case['id'] for case in expected['cases']]
    actual_cases = {case['id']: case for case in actual['cases']}
    if set(ids) != set(actual_cases) or len(actual_cases) != len(actual['cases']):
        raise ValueError('candidate must contain every golden case exactly once')
    limits = THRESHOLDS[route]
    errors, worst, min_cosine = [], 0.0, 1.0
    for case in expected['cases']:
        reference_file = expected_dir / case['file']
        if sha256(reference_file) != case['sha256']:
            raise ValueError(f"Golden integrity failure: {case['id']}")
        candidate_case = actual_cases[case['id']]
        for key in ('texts', 'role'):
            if case[key] != candidate_case[key]:
                raise ValueError(f"Input differs: {case['id']}/{key}")
        candidate_file = actual_dir / candidate_case['file']
        if sha256(candidate_file) != candidate_case['sha256']:
            raise ValueError(f"Candidate integrity failure: {case['id']}")
        with np.load(reference_file, allow_pickle=False) as ref, np.load(candidate_file, allow_pickle=False) as candidate:
            if set(ref.files) != set(candidate.files):
                raise ValueError(f"Missing or extra stage arrays: {case['id']}")
            for name in ref.files:
                a, b = ref[name], candidate[name]
                label = f"{case['id']}/{name}"
                if a.shape != b.shape:
                    errors.append(f'{label}: shape mismatch')
                    continue
                if name in ('input_ids', 'attention_mask', 'token_type_ids'):
                    if not np.array_equal(a, b):
                        errors.append(f'{label}: token/mask mismatch')
                    continue
                if not np.isfinite(b).all():
                    errors.append(f'{label}: nonfinite value')
                    continue
                delta = float(np.max(np.abs(a.astype(np.float64) - b)))
                worst = max(worst, delta)
                atol, rtol = (limits['vector_atol'], 0) if name == 'vectors' else (limits['atol'], limits['rtol'])
                if not np.allclose(a, b, atol=atol, rtol=rtol):
                    errors.append(f'{label}: numeric drift (max abs {delta})')
                if name == 'vectors':
                    norm_a = np.linalg.norm(a.astype(np.float64), axis=1)
                    norm_b = np.linalg.norm(b.astype(np.float64), axis=1)
                    cosine = np.sum(a.astype(np.float64) * b, axis=1) / np.maximum(norm_a * norm_b, 1e-30)
                    min_cosine = min(min_cosine, float(cosine.min()))
                    if (cosine < limits['min_cosine']).any():
                        errors.append(f'{label}: cosine below threshold')
                    if not np.allclose(norm_b, 1, atol=limits['norm_atol'], rtol=0):
                        errors.append(f'{label}: nonunit output')
    report = {'route': route, 'cases': len(ids),
              'reference_manifest_sha256': sha256(expected_dir / 'manifest.json'),
              'candidate_manifest_sha256': sha256(actual_dir / 'manifest.json'),
              'candidate_backend': actual.get('backend'), 'thresholds': limits, 'max_absolute_error': worst,
              'minimum_cosine': min_cosine, 'passed': not errors, 'errors': errors}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('--goldens', type=Path, default=ROOT / 'tests/goldens')
    parser.add_argument('--route', choices=THRESHOLDS, required=True)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    report = compare(args.goldens, args.candidate, args.route)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report['passed'] else 1)
