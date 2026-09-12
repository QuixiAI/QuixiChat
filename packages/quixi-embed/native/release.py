#!/usr/bin/env python3
"""Publish or verify the repository-owned, versioned CPU WASM distribution."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
from build import ROOT, IMAGE, VERSION

def release(write=False):
    destination=ROOT/'artifacts'/VERSION
    artifacts={}
    for route in ['scalar','simd']:
        source=ROOT/f'build/quixi-{route}.wasm'
        evidence=json.loads(source.with_suffix('.wasm.json').read_text())
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        if digest!=evidence['sha256'] or evidence['diagnostic'] or evidence['profile']:
            raise ValueError('Expected checksummed production WASM build')
        artifacts[source.name]={'sha256':digest,'bytes':source.stat().st_size,'route':f'wasm-{route}-fp32',
                                'sources':evidence['sources'],'simd_required':route=='simd'}
    manifest={'version':VERSION,'model_format_version':1,'compiler_image':IMAGE,
              'model_sha256':hashlib.sha256((ROOT/'build/arctic-xs.qxmodel').read_bytes()).hexdigest(),
              'artifacts':artifacts}
    if write:
        destination.mkdir(parents=True,exist_ok=True)
        for name in artifacts:shutil.copyfile(ROOT/'build'/name,destination/name)
        (destination/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    else:
        if json.loads((destination/'manifest.json').read_text())!=manifest:raise ValueError('Distribution manifest differs from reproducible build')
        for name,metadata in artifacts.items():
            if hashlib.sha256((destination/name).read_bytes()).hexdigest()!=metadata['sha256']:raise ValueError('Distribution artifact checksum mismatch')
    print(f'{"Published" if write else "Verified"} CPU WASM distribution {VERSION}')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write',action='store_true',help='Replace this local versioned distribution explicitly')
    release(parser.parse_args().write)
