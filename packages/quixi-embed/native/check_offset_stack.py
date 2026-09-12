#!/usr/bin/env python3
"""Record pinned WASM compiler stack frames for bounded offset provenance."""
import json
import subprocess
from build import ROOT, IMAGE, VERSION
from fetch import sha256

report_path=ROOT/'build/token-offset-stack.json'
command=['docker','run','--rm','--platform','linux/amd64','--mount',f'type=bind,source={ROOT},target=/src',IMAGE,
         'emcc','-std=c11','-O2','-ffp-contract=off','-fno-vectorize','-fno-slp-vectorize','-fstack-usage',
         '-c','/src/native/tokenizer.c','-o','/src/build/tokenizer-offset-stack.o']
report=dict(passed=False,status='running',artifactVersion=VERSION,command=command)
report_path.write_text(json.dumps(report,indent=2)+'\n')
try:
    subprocess.run(command,check=True)
    source=ROOT/'build/tokenizer-offset-stack.su'
    frames={}
    for line in source.read_text().splitlines():
        location,size,kind=line.split('\t');assert kind=='static'
        frames[location.rsplit(':',1)[1]]=int(size)
    total=sum(frames[name] for name in ['qx_tokenize_offsets','process','normalized_cp','flush'])
    assert total<1048576
    report.update(passed=True,status='passed',frames=frames,offsetPathTokenizerFrameSum=total,
                  explicitProvenanceArrayBytes=6400,reservedWasmStackBytes=1048576,stackUsageSha256=sha256(source),
                  scope='Sum of compiler-reported tokenizer frames on the nonrecursive offset path; excludes caller/libc frames. Same pinned production optimization flags.')
except BaseException as error:
    report.update(status='failed',error=str(error));raise
finally:
    report_path.write_text(json.dumps(report,indent=2)+'\n')
