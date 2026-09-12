#!/usr/bin/env python3
"""Add independent 15/16/17-token full-graph goldens around the new GPU tile boundary."""
import json
import numpy as np
from runtime import Reference,environment
from fetch import ROOT,sha256
output=ROOT/'tests/gpu/goldens'
output.mkdir(parents=True,exist_ok=True)
reference=Reference()
manifest={'version':1,'source':reference.lock,'environment':environment(),
          'coverage':{'reason':'16-row GPU projection tile boundary','batches':[1,4,8,16,32],'lengths':[15,16,17]},'cases':[]}
for role in ['document','query']:
    for tokens in [15,16,17]:
        for batch in [1,4,8,16,32]:
            texts=[' '.join([['token','hello','world','model'][i%4]]*(tokens-(10 if role=='query' else 2)-i%3)) for i in range(batch)]
            arrays=reference.forward(texts,role,True)
            assert arrays['input_ids'].shape==(batch,tokens)
            name=f'gpu-tile-{role}-b{batch}-t{tokens}'
            path=output/(name+'.npz');np.savez_compressed(path,**arrays)
            manifest['cases'].append({'id':name,'role':role,'texts':texts,'stages':True,'file':path.name,'sha256':sha256(path),
                'arrays':{key:{'shape':list(value.shape),'dtype':str(value.dtype)} for key,value in arrays.items()}})
(output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Generated {len(manifest["cases"])} supplemental full-graph cases; original 159 goldens unchanged')
