#!/usr/bin/env python3
"""Reproduce native scalar and Docker-built WASM SIMD C ABI feasibility evidence."""
import argparse
import json
import platform
from pathlib import Path
import subprocess
from fetch import ROOT, sha256

IMAGE = 'emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7'


def run(args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()


def check(report):
    build = ROOT / 'build'
    build.mkdir(exist_ok=True)
    native = build / 'probe-native'
    run(['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DQX_PROBE_MAIN',
         str(ROOT / 'native/toolchain_probe.c'), '-o', str(native)])
    run([str(native)])
    docker = ['docker', 'run', '--rm', '--platform', 'linux/amd64', '--mount',
              f'type=bind,source={ROOT},target=/src', IMAGE]
    run(docker + ['emcc', '/src/native/toolchain_probe.c', '-std=c11', '-O2', '-msimd128', '--no-entry',
                  '-sSTANDALONE_WASM', '-Wl,--export=qx_probe_dot4', '-Wl,--export-memory',
                  '-o', '/src/build/probe.wasm'])
    # Use an exported heap base when present; 1024 is free for this no-data
    # probe. This is feasibility code, not the production allocation contract.
    script = '''
const fs = require('node:fs');
const bytes = fs.readFileSync(process.argv[1]);
const module = new WebAssembly.Module(bytes);
const instance = new WebAssembly.Instance(module, {wasi_snapshot_preview1: {proc_exit: () => {throw Error('exit');}}});
const array = new Float32Array(instance.exports.memory.buffer, 1024, 8);
array.set([1,2,3,4,5,6,7,8]);
const result = instance.exports.qx_probe_dot4(1024, 1040);
if (result !== 70) throw Error('WASM/native mismatch: ' + result);
console.log(JSON.stringify({result, imports: WebAssembly.Module.imports(module)}));
'''
    wasm_result = json.loads(run(['node', '-e', script, str(build / 'probe.wasm')]))
    evidence = {'platform': platform.platform(), 'clang': run(['clang', '--version']),
                'node': run(['node', '--version']), 'emscripten': run(docker + ['emcc', '--version']),
                'image': IMAGE, 'source_sha256': sha256(ROOT / 'native/toolchain_probe.c'),
                'wasm_sha256': sha256(build / 'probe.wasm'), 'native_exit_code': 0,
                'wasm': wasm_result, 'limitations': 'Four-element ABI/SIMD proof, not inference performance or browser validation.'}
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, default=ROOT / 'build/toolchain-evidence.json')
    check(parser.parse_args().report)
