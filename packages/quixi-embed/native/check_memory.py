#!/usr/bin/env python3
"""Measure allocator peaks using unchanged production sources plus one observer export."""
import hashlib
import json
import subprocess
from build import ROOT,IMAGE,SOURCES,EXPORTS
output=ROOT/'build/quixi-simd-memory.wasm'
command=['docker','run','--rm','--platform','linux/amd64','--mount',f'type=bind,source={ROOT},target=/src',IMAGE,
    'emcc','-std=c11','-O2','-ffp-contract=off','-fno-vectorize','-fno-slp-vectorize','-Wall','-Wextra','-Werror',
    '-DQX_SIMD','-msimd128',*['/src/native/'+name for name in SOURCES],'/src/tests/allocator_probe.c','-lm','--no-entry',
    '-sSTANDALONE_WASM','-sALLOW_MEMORY_GROWTH=1','-sMAXIMUM_MEMORY=536870912','-sINITIAL_MEMORY=16777216','-sSTACK_SIZE=1048576',
    '-sEXPORTED_FUNCTIONS='+json.dumps(['_'+name for name in EXPORTS+['qx_heap_usage']]),'-o','/src/build/'+output.name]
subprocess.run(command,check=True)
metadata={'command':command,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
          'production_sources':{name:hashlib.sha256((ROOT/'native'/name).read_bytes()).hexdigest() for name in SOURCES},
          'observer_sha256':hashlib.sha256((ROOT/'tests/allocator_probe.c').read_bytes()).hexdigest(),
          'scope':'Same production sources and allocation order; one separate mallinfo observer, no diagnostic stage buffers.'}
output.with_suffix('.wasm.json').write_text(json.dumps(metadata,indent=2)+'\n')
subprocess.run(['node',str(ROOT/'tests/allocator-memory.mjs')],check=True)
