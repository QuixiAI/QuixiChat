#!/usr/bin/env python3
"""Build the independent C11 scalar runtime; no UI, database, or server required."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'reference'))
from fetch import sha256
IMAGE = 'emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7'
VERSION = '1.0.2'
SOURCES = ['model.c', 'tokenizer.c', 'encoder.c', 'sha256.c']
EXPORTS = ['qx_sha256', 'qx_backend', 'qx_inspect_tokens', 'qx_tokenizer_inspect', 'qx_tokenize_offsets', 'qx_tokenizer_encode_offsets', 'qx_tokenizer_load', 'qx_tokenizer_free', 'qx_tokenizer_bytes', 'qx_tokenizer_encode', 'malloc', 'free', 'qx_model_load', 'qx_model_free', 'qx_model_bytes',
           'qx_workspace_create', 'qx_workspace_free', 'qx_workspace_bytes',
           'qx_tokenize', 'qx_embed_tokens', 'qx_embed_document', 'qx_embed_query', 'qx_status_message']


def build(target, diagnostic, profile=False, simd=False):
    directory = ROOT / 'build';directory.mkdir(exist_ok=True)
    flags = ['-std=c11', '-O2', '-ffp-contract=off', '-fno-vectorize', '-fno-slp-vectorize', '-Wall', '-Wextra', '-Werror']
    if simd:
        if target != 'wasm': raise ValueError('SIMD requires the WASM target')
        flags += ['-DQX_SIMD', '-msimd128']
    if diagnostic:
        flags += ['-DQX_DIAGNOSTICS']
    if profile:
        if target != 'wasm': raise ValueError('Profiling uses the WASM monotonic timer')
        flags += ['-DQX_PROFILE']
    if target == 'native':
        suffix = '.dylib' if sys.platform == 'darwin' else '.so'
        output = directory / ('libquixi_embed' + ('_production' if not diagnostic else '') + suffix)
        command = ['clang', *flags, '-shared', '-fPIC', *[str(ROOT / 'native' / name) for name in SOURCES], '-lm', '-o', str(output)]
    else:
        output = directory / (('quixi-simd' if simd else 'quixi-scalar') + ('-diagnostic' if diagnostic else '') + ('-profile' if profile else '') + '.wasm')
        exports = EXPORTS + (['qx_diagnostic_stage', 'qx_diagnostic_pooled'] if diagnostic else []) + (['qx_profile_time'] if profile else [])
        command = ['docker', 'run', '--rm', '--platform', 'linux/amd64', '--mount', f'type=bind,source={ROOT},target=/src', IMAGE,
                   'emcc', *flags, *['/src/native/' + name for name in SOURCES], '-lm', '--no-entry', '-sSTANDALONE_WASM',
                   '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=536870912', '-sINITIAL_MEMORY=16777216', '-sSTACK_SIZE=1048576',
                   '-sEXPORTED_FUNCTIONS=' + json.dumps(['_' + name for name in exports]), '-o', '/src/build/' + output.name]
    subprocess.run(command, check=True)
    if target == 'native' and not diagnostic:
        cli = directory / 'qx-embed'
        subprocess.run(['clang', *flags, *[str(ROOT / 'native' / name) for name in SOURCES], str(ROOT / 'native/cli.c'), '-lm', '-o', str(cli)], check=True)
    evidence = {'target': target, 'diagnostic': diagnostic, 'profile': profile, 'platform': platform.platform(),
                'command': command, 'output': output.name, 'bytes': output.stat().st_size, 'sha256': sha256(output),
                'sources': {name: sha256(ROOT / 'native' / name) for name in SOURCES + ['kernels.h', 'internal.h', 'model_contract.h', 'quixi_embed.h']},
                'artifact_version': VERSION, 'model_format_version': 1, 'simd_enabled': simd, 'generic_runtime': False}
    output.with_suffix(output.suffix + '.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['native','wasm'], default='native')
    parser.add_argument('--diagnostic', action='store_true')
    parser.add_argument('--profile', action='store_true')
    parser.add_argument('--simd', action='store_true')
    args = parser.parse_args();build(args.target, args.diagnostic, args.profile, args.simd)
