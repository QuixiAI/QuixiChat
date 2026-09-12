#!/usr/bin/env python3
"""Build each kernel against the unchanged scalar arithmetic before inference tests."""
import json
import subprocess
from build import ROOT, IMAGE
for simd in [False,True]:
    route='simd' if simd else 'scalar'
    flags=['-DQX_SIMD','-msimd128'] if simd else []
    subprocess.run(['docker','run','--rm','--platform','linux/amd64','--mount',f'type=bind,source={ROOT},target=/src',IMAGE,
        'emcc','-std=c11','-O2','-ffp-contract=off','-fno-vectorize','-fno-slp-vectorize',*flags,
        '/src/tests/kernels.c','--no-entry','-sSTANDALONE_WASM','-sEXPORTED_FUNCTIONS='+json.dumps(['_malloc','_free','_qx_test_dot','_qx_test_axpy']),
        '-o',f'/src/build/kernels-{route}.wasm'],check=True)
subprocess.run(['node',str(ROOT/'tests/kernel-parity.mjs')],check=True)
