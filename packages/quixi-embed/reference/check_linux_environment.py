#!/usr/bin/env python3
"""Verify the Linux CPU-only reference environment and cross-platform compiler identity."""
import importlib.metadata
import json
from pathlib import Path
import platform
import subprocess
import sys
import numpy as np
import torch
from fetch import ROOT, sha256
from runtime import Reference

assert sys.platform=='linux' and platform.machine()=='x86_64'
assert torch.__version__=='2.6.0+cpu' and torch.version.cuda is None
names=[distribution.metadata['Name'].lower() for distribution in importlib.metadata.distributions()]
assert not any(name.startswith('nvidia-') for name in names)
subprocess.run([sys.executable,'-m','pip','check'],check=True)
subprocess.run([sys.executable,str(ROOT/'compiler/compile_model.py'),'--output',str(ROOT/'build/linux-reference/arctic-xs.qxmodel')],check=True)
assert sha256(ROOT/'build/linux-reference/arctic-xs.qxmodel')=='e1ef345cd35088b06f70c199f5a4e0311bda5983716ad6a3e7d0a604202efffc'
reference=Reference();manifest=json.loads((ROOT/'tests/goldens/manifest.json').read_text());maximum=0.0
for case in manifest['cases'][:4]:
    actual=reference.forward(case['texts'],case['role'],case['stages'])
    with np.load(ROOT/'tests/goldens'/case['file']) as expected:
        for name,value in actual.items():
            if name in ('input_ids','attention_mask','token_type_ids'):
                assert np.array_equal(value,expected[name]),(case['id'],name)
            else:
                maximum=max(maximum,float(np.abs(value-expected[name]).max()))
                if name=='vectors':assert np.allclose(value,expected[name],atol=2e-5,rtol=0)
                else:assert np.allclose(value,expected[name],atol=1e-4,rtol=1e-4)
report={'passed':True,'platform':platform.platform(),'python':sys.version,'torch':torch.__version__,
        'cuda':torch.version.cuda,'reference_cases':4,'maximum_absolute_error':maximum,
        'requirements_sha256':sha256(ROOT/'reference/requirements-linux-cpu.lock'),
        'model_sha256':sha256(ROOT/'build/linux-reference/arctic-xs.qxmodel'),
        'packages':sorted(names)}
(ROOT/'build/linux-environment-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
