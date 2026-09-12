#!/usr/bin/env python3
"""Provision and reproduce standalone original-source token offset gates."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
REPO=ROOT.parents[1]


def main(skip_provision=False, full=False):
    output=ROOT/'build/token-offset-ci.json'
    output.parent.mkdir(parents=True,exist_ok=True)
    report=dict(passed=False,status='running',startedAt=datetime.now(timezone.utc).isoformat(),
                skipProvision=skip_provision,full=full,commands=[])

    def save():
        temporary=output.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(report,indent=2)+'\n');temporary.replace(output)

    save()

    def run(command):
        command=[str(value) for value in command]
        entry=dict(command=command,status='running');report['commands'].append(entry);save()
        started=time.perf_counter()
        try:
            result=subprocess.run(command,cwd=REPO,check=False)
            entry.update(exitCode=result.returncode,status='passed' if result.returncode==0 else 'failed')
            if result.returncode:raise subprocess.CalledProcessError(result.returncode,command)
        except BaseException as error:
            entry.update(status='failed',error=str(error));report['failedCommand']=command;raise
        finally:
            entry['seconds']=time.perf_counter()-started;save()

    try:
        run([REPO/'node_modules/.bin/tsc','-p',ROOT/'tsconfig.gpu.json'])
        run([sys.executable,'-m','unittest','discover','-s',ROOT/'tests','-p','test_offset_ci.py'])
        if not skip_provision:
            run([sys.executable,ROOT/'native/ci.py','--simd','--browsers'])
        python=ROOT/'build/reference-env/bin/python'
        run([sys.executable,ROOT/'native/build.py','--target','native'])
        run([sys.executable,ROOT/'native/release.py'])
        run([python,ROOT/'reference/generate_offset_fixtures.py','--verify'])
        run([python,ROOT/'reference/generate_offset_fixtures.py','--exhaustive'])
        run([python,ROOT/'reference/check_offsets_native.py'])
        run([python,ROOT/'reference/check_offsets_native.py','--fixtures',ROOT/'build/token-offset-exhaustive.jsonl','--report',ROOT/'build/token-offset-native-exhaustive.json'])
        run(['node','--experimental-strip-types',ROOT/'tests/token-offsets.mjs'])
        run(['node','--experimental-strip-types',ROOT/'tests/token-offsets.mjs',ROOT/'build/token-offset-exhaustive.jsonl'])
        run([sys.executable,ROOT/'native/check_offset_safety.py'])
        run([sys.executable,ROOT/'native/check_offset_stack.py'])
        run(['node','--experimental-strip-types',ROOT/'tests/token-preflight.mjs'])
        for route in ['scalar','simd']:
            run(['node','--experimental-strip-types',ROOT/'tests/scalar-api.mjs',route])
        for engine in ['chromium','firefox','webkit']:
            for route in ['scalar','simd']:
                run(['node',ROOT/'tests/offsets/run.mjs',engine,route])
        if full:
            for route in ['native','scalar','simd']:
                run([sys.executable,ROOT/'native/build.py','--target','native' if route=='native' else 'wasm','--diagnostic',*(['--simd'] if route=='simd' else [])])
                candidate=ROOT/f'build/offset-{route}-goldens'
                if route=='native':
                    run([python,ROOT/'reference/generate_native.py','--output',candidate])
                else:
                    raw=ROOT/f'build/offset-{route}-raw'
                    run(['node',ROOT/'reference/generate_wasm.mjs',raw,route])
                    run([python,ROOT/'reference/convert_wasm.py','--source',raw,'--output',candidate])
                run([python,ROOT/'reference/compare.py',candidate,'--route','wasm-simd-fp32' if route=='simd' else 'scalar-fp32','--report',ROOT/f'build/offset-{route}-parity.json'])
        report.update(passed=True,status='passed')
    except BaseException as error:
        report.update(passed=False,status='failed',error=str(error));raise
    finally:
        report['finishedAt']=datetime.now(timezone.utc).isoformat();save()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-provision',action='store_true',help='Require existing verified assets/reference environment/browser binaries; native safety/stack checks still compile')
    parser.add_argument('--full',action='store_true',help='Also rebuild diagnostics and run all159 native/scalar/SIMD numerical cases')
    args=parser.parse_args();main(args.skip_provision,args.full)
