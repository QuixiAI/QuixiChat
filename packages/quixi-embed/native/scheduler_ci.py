#!/usr/bin/env python3
"""Provision and verify the bounded scheduler; optional GPU gates require real adapters."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]


def main(skip_provision=False, gpu=False, full=False):
    output = ROOT / 'build/scheduler-ci-report.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    report = dict(status='running', passed=False, started_at=datetime.now(timezone.utc).isoformat(),
                  skip_provision=skip_provision, gpu=gpu, full=full, commands=[])

    def save():
        temporary = output.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(output)

    save()

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
        run(['node', '--experimental-strip-types', '--test', ROOT / 'tests/scheduler.mjs'])
        run([REPO / 'node_modules/.bin/tsc', '-p', ROOT / 'tsconfig.gpu.json'])
        run([sys.executable, '-m', 'unittest', 'discover', '-s', ROOT / 'tests', '-p', 'test_scheduler_ci.py'])
        if not skip_provision:
            # Verified Linux CPU-only lock / macOS arm64 lock and pinned Docker SDK.
            # Also installs Chromium, Firefox and WebKit binaries. CI supplies OS libraries.
            run([sys.executable, ROOT / 'native/ci.py', '--simd', '--browsers'])
        python = ROOT / 'build/reference-env/bin/python'
        run([sys.executable, ROOT / 'native/release.py'])
        run([sys.executable, ROOT / 'native/gpu_release.py'])
        run([python, ROOT / 'reference/generate_preflight_fixtures.py', '--verify'])
        run(['node', '--experimental-strip-types', ROOT / 'tests/token-preflight.mjs'])
        run(['node', '--experimental-strip-types', ROOT / 'tests/scalar-api.mjs'])
        run(['node', '--experimental-strip-types', ROOT / 'tests/scalar-api.mjs', 'simd'])
        for engine in ['chromium', 'firefox', 'webkit']:
            for route in ['scalar', 'simd']:
                run(['node', ROOT / 'tests/scheduler/run.mjs', engine, route])
        if gpu:
            for engine in ['chromium', 'webkit']:
                for route, flags in [('gpu', []), ('half', []), ('gpu', ['--loss'])]:
                    run(['node', ROOT / 'tests/scheduler/run.mjs', engine, route, *flags])
        if full:
            # Full recertification is available independently of provisioning mode.
            for route in ['native', 'scalar', 'simd']:
                run([sys.executable, ROOT / 'native/build.py', '--target', 'native' if route == 'native' else 'wasm',
                     '--diagnostic', *(['--simd'] if route == 'simd' else [])])
                candidate = ROOT / f'build/scheduler-{route}-goldens'
                if route == 'native':
                    run([python, ROOT / 'reference/generate_native.py', '--output', candidate])
                else:
                    raw = ROOT / f'build/scheduler-{route}-raw'
                    run(['node', ROOT / 'reference/generate_wasm.mjs', raw, route])
                    run([python, ROOT / 'reference/convert_wasm.py', '--source', raw, '--output', candidate])
                run([python, ROOT / 'reference/compare.py', candidate, '--route',
                     'wasm-simd-fp32' if route == 'simd' else 'scalar-fp32',
                     '--report', ROOT / f'build/scheduler-{route}-parity.json'])
        report.update(status='passed', passed=True)
    except BaseException as error:
        report.update(status='failed', passed=False, error=str(error))
        raise
    finally:
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-provision', action='store_true', help='Require existing verified reference environment, model, WASM and browsers')
    parser.add_argument('--gpu', action='store_true', help='Require actual Chromium/WebKit WebGPU including f16 and in-flight device loss')
    parser.add_argument('--full', action='store_true', help='Also rebuild diagnostic native/scalar/SIMD and compare all 159 frozen cases per route')
    args = parser.parse_args()
    main(args.skip_provision, args.gpu, args.full)
