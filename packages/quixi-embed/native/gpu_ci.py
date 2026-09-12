#!/usr/bin/env python3
"""Reproduce WebGPU gates on a real adapter. Unavailable hardware exits nonzero."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time
ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]


def main(engines, full=False, skip_provision=False):
    output = ROOT / 'build/gpu-ci-report.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    report = dict(status='running', passed=False, started_at=datetime.now(timezone.utc).isoformat(),
                  engines=engines, full=full, skip_provision=skip_provision, commands=[])

    def save():
        temporary = output.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(output)

    save()  # Invalidate previous success before any preflight or provisioning.

    def run(command):
        command = [str(value) for value in command]
        entry = dict(command=command, status='running')
        report['commands'].append(entry)
        save()
        start = time.perf_counter()
        try:
            result = subprocess.run(command, cwd=REPO, check=False)
            entry.update(exit_code=result.returncode, seconds=time.perf_counter()-start,
                         status='passed' if result.returncode == 0 else 'failed')
            if result.returncode:
                raise subprocess.CalledProcessError(result.returncode, command)
        except BaseException as error:
            entry.update(status='failed', error=str(error), seconds=time.perf_counter()-start)
            report['failed_command'] = command
            raise
        finally:
            save()

    try:
        run([sys.executable, ROOT / 'native/gpu_release.py'])
        run(['node', '--experimental-strip-types', ROOT / 'tests/gpu-tuning.mjs'])
        run([REPO / 'node_modules/.bin/tsc', '-p', ROOT / 'tsconfig.gpu.json'])
        run([sys.executable, '-m', 'unittest', 'discover', '-s', ROOT / 'tests', '-p', 'test_gpu_*.py'])
        if not skip_provision:
            run(['npx', 'playwright', 'install', *engines])
        for engine in engines:
            run(['node', ROOT / 'tests/gpu/probe.mjs', engine])
        if not skip_provision:
            # Existing provisioner uses the verified Linux CPU-only lock on Linux,
            # the macOS lock on arm64, and the pinned Docker Emscripten toolchain.
            run([sys.executable, ROOT / 'native/ci.py', '--simd', '--browsers'])
        python = ROOT / 'build/reference-env/bin/python'
        run([python, ROOT / 'reference/generate_gpu_kernel_fixtures.py'])
        run(['node', '--experimental-strip-types', ROOT / 'tests/scalar-api.mjs', 'simd'])
        run(['node', '--experimental-strip-types', ROOT / 'tests/scalar-api.mjs'])
        for engine in engines:
            for variant in ['', '--tiled', '--half']:
                run(['node', ROOT / 'tests/gpu/run.mjs', engine, '--kernels'] + ([variant] if variant else []))
            run(['node', ROOT / 'tests/gpu/run.mjs', engine, '--lifecycle'])
            if full:
                for name, flags in [('baseline', []), ('tiled', ['--tiled']), ('half', ['--half']),
                                    ('baseline-fused', ['--fused']), ('tiled-fused', ['--tiled', '--fused']),
                                    ('half-fused', ['--half', '--fused']), ('auto-fused', ['--auto', '--fused'])]:
                    for boundaries in [False, True]:
                        prefix = ROOT / f'build/gpu-final-{engine}-{name}{"-boundaries" if boundaries else ""}'
                        raw, candidate = Path(str(prefix)+'-raw'), Path(str(prefix)+'-goldens')
                        goldens = ROOT / ('tests/gpu/goldens' if boundaries else 'tests/goldens')
                        route = 'webgpu-fp16' if name.startswith('half') else 'webgpu-fp32'
                        run(['node', ROOT / 'reference/generate_gpu.mjs', engine, raw] + flags + (['--boundaries'] if boundaries else []))
                        run([python, ROOT / 'reference/convert_wasm.py', '--source', raw, '--output', candidate, '--goldens', goldens])
                        run([python, ROOT / 'reference/compare.py', candidate, '--goldens', goldens, '--route', route, '--report', str(prefix)+'-parity.json'])
                for projection,attention in [('baseline','baseline'),('tiled','baseline'),('half','baseline'),('baseline','fused'),('tiled','fused'),('auto','fused'),('half','fused')]:
                    run([python, ROOT / 'reference/check_retrieval.py', '--route', 'gpu-fp16' if projection == 'half' else 'gpu-fp32',
                         '--engine', engine, '--projection', projection, '--attention', attention,
                         '--report', ROOT / f'build/gpu-final-{engine}-{projection}-{attention}-retrieval.json'])
        report.update(status='passed', passed=True)
    except BaseException as error:
        report.update(status='failed', passed=False, error=str(error))
        raise
    finally:
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engines', nargs='+', choices=['chromium', 'webkit'], default=['chromium'])
    parser.add_argument('--full', action='store_true')
    parser.add_argument('--skip-provision', action='store_true', help='Require existing verified model, tokenizer, WASM and reference environment')
    args = parser.parse_args()
    main(args.engines, args.full, args.skip_provision)
