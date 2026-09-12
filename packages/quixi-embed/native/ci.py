#!/usr/bin/env python3
"""Provision frozen inputs and run independent scalar checks on Linux x86_64 or macOS arm64."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]


def main(full=False, browsers=False, simd=False):
    report_path = ROOT / ('build/ci-simd-report.json' if simd else 'build/ci-report.json')
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {'status': 'running', 'passed': False, 'mode': 'full' if full else 'smoke',
              'browsers': browsers, 'backend': 'simd' if simd else 'scalar', 'platform': platform.platform(),
              'started_at': datetime.now(timezone.utc).isoformat(), 'commands': []}

    def save():
        temporary = report_path.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(report_path)

    # Invalidate any prior success before preflight checks or provisioning.
    save()

    def run(command):
        command = [str(value) for value in command]
        entry = {'command': command, 'status': 'running'}
        report['commands'].append(entry)
        save()
        start = time.perf_counter()
        try:
            result = subprocess.run(command, check=False, cwd=REPO)
            entry.update(exit_code=result.returncode, seconds=time.perf_counter() - start,
                         status='passed' if result.returncode == 0 else 'failed')
            save()
            if result.returncode:
                report['failed_command'] = command
                raise subprocess.CalledProcessError(result.returncode, command)
        except BaseException as error:
            entry.update(status='failed', seconds=time.perf_counter() - start, error=str(error))
            report['failed_command'] = command
            save()
            raise

    try:
        for tool in (('uv', 'docker', 'node') if simd else ('uv', 'clang', 'docker', 'node')):
            if not shutil.which(tool):
                raise RuntimeError(f'Required provisioning tool missing: {tool}')
        if sys.platform == 'linux' and platform.machine() == 'x86_64':
            lock = ROOT / 'reference/requirements-linux-cpu.lock'
        elif sys.platform == 'darwin' and platform.machine() == 'arm64':
            lock = ROOT / 'reference/requirements.lock'
        else:
            raise RuntimeError('This provisioning entry supports Linux x86_64 and macOS arm64')
        report['requirements'] = lock.name
        environment = ROOT / 'build/reference-env'
        python = environment / 'bin/python'
        if not python.exists():
            run(['uv', 'venv', '--python', '3.11.15', environment])
        run(['uv', 'pip', 'sync', '--python', python, '--require-hashes', lock])
        run([python, ROOT / 'reference/fetch.py'])
        run([python, ROOT / 'compiler/compile_model.py'])
        if not simd:
            run([sys.executable, ROOT / 'native/build.py', '--target', 'native'])
        run([sys.executable, ROOT / 'native/build.py', '--target', 'wasm'])
        if simd:
            run([sys.executable, ROOT / 'native/build.py', '--target', 'wasm', '--simd'])
            run([sys.executable, ROOT / 'native/check_kernels.py'])
            run([sys.executable, ROOT / 'native/check_memory.py'])
            run(['node', '--expose-gc', '--experimental-strip-types', ROOT / 'tests/cpu-memory.mjs'])
            run([python, '-m', 'unittest', 'discover', '-s', ROOT / 'tests', '-p', 'test_performance.py'])
            run(['node', ROOT / 'tests/perf-reporting.mjs'])
            run([sys.executable, ROOT / 'native/release.py'])
        run([python, '-m', 'unittest', 'discover', '-s', ROOT / 'reference', '-p', 'test_*.py'])
        run([python, '-m', 'unittest', 'discover', '-s', ROOT / 'tests', '-p', 'test_ci_report.py' if simd else 'test_*.py'])
        run([python, '-m', 'unittest', 'discover', '-s', REPO / 'perf/retrieval', '-p', 'test_*.py'])
        if not simd:
            run([python, ROOT / 'reference/check_unicode.py'])
        run([python, ROOT / 'reference/generate_browser_fixtures.py', '--verify'])
        run(['node', '--experimental-strip-types', ROOT / 'tests/scalar-api.mjs'])
        if simd:
            run(['node', '--experimental-strip-types', ROOT / 'tests/scalar-api.mjs', 'simd'])
        if full and simd:
            run([sys.executable, ROOT / 'native/build.py', '--target', 'wasm', '--simd', '--diagnostic'])
            run(['node', ROOT / 'reference/generate_wasm.mjs', ROOT / 'build/simd-raw', 'simd'])
            run([python, ROOT / 'reference/convert_wasm.py', '--source', ROOT / 'build/simd-raw', '--output', ROOT / 'build/simd-goldens'])
            run([python, ROOT / 'reference/compare.py', ROOT / 'build/simd-goldens', '--route', 'wasm-simd-fp32', '--report', ROOT / 'build/simd-parity-report.json'])
            run([python, ROOT / 'reference/check_retrieval.py', '--route', 'simd', '--report', ROOT / 'build/simd-retrieval-report.json'])
        if full and not simd:
            run([sys.executable, ROOT / 'native/build.py', '--target', 'native', '--diagnostic'])
            run([sys.executable, ROOT / 'native/build.py', '--target', 'wasm', '--diagnostic'])
            run([python, ROOT / 'reference/generate_native.py'])
            run([python, ROOT / 'reference/compare.py', ROOT / 'build/native-goldens', '--route', 'scalar-fp32', '--report', ROOT / 'build/native-parity-report.json'])
            run(['node', ROOT / 'reference/generate_wasm.mjs'])
            run([python, ROOT / 'reference/convert_wasm.py'])
            run([python, ROOT / 'reference/compare.py', ROOT / 'build/wasm-goldens', '--route', 'scalar-fp32', '--report', ROOT / 'build/wasm-parity-report.json'])
            run([python, ROOT / 'reference/check_retrieval.py'])
        if browsers:
            run(['npx', 'playwright', 'install', 'chromium', 'firefox', 'webkit'])
            run(['node', ROOT / 'tests/browser-check.mjs'])
            if simd:
                run(['node', ROOT / 'tests/browser-check.mjs', 'simd'])
        report.update(status='passed', passed=True)
    except BaseException as error:
        report.update(status='failed', passed=False, error=str(error))
        if isinstance(error, subprocess.CalledProcessError):
            report['exit_code'] = error.returncode
        raise
    finally:
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--full', action='store_true', help='Run complete native/WASM numerical and retrieval checks (tens of minutes)')
    parser.add_argument('--browsers', action='store_true', help='Provision browser binaries and run workers; Linux system libraries must already be installed')
    parser.add_argument('--simd', action='store_true', help='Verify SIMD plus scalar WASM oracle; no desktop native compiler or library required')
    args = parser.parse_args()
    main(args.full, args.browsers, args.simd)
