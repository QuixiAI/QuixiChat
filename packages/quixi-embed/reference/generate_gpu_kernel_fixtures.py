#!/usr/bin/env python3
"""Independent FP64 offline math oracle for the fixed WGSL kernel families."""
import json
import math
from pathlib import Path
import hashlib
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'build/gpu-kernel-fixtures'
OUT.mkdir(parents=True,exist_ok=True)
rng=np.random.default_rng(1901)
cases=[]
def random(shape):return rng.normal(0,0.2,shape).astype('<f4')
def add(kernel,bindings,expected,params,dispatch,name=None):
    assert np.isfinite(expected).all(),f'Nonfinite oracle: {kernel}'
    blob=bytearray();layout={}
    for key,value in {**bindings,'expected':np.asarray(expected,dtype='<f4')}.items():
        value=np.asarray(value);data=value.tobytes();layout[str(key)]={'offset':len(blob),'bytes':len(data),'shape':list(value.shape),'dtype':str(value.dtype)};blob.extend(data)
    name=name or f'{kernel}-{len(cases)}';file=name+'.bin';(OUT/file).write_bytes(blob)
    cases.append({'name':name,'kernel':kernel,'file':file,'sha256':hashlib.sha256(blob).hexdigest(),'layout':layout,'params':params+[0]*(8-len(params)),'dispatch':dispatch})
for rows in [1,15,16,17,33]:
    for width,out in [(384,384),(384,1536),(1536,384)]:
        x=random((rows,width));w=random((out,width));b=random(out)
        add('linear',{0:np.concatenate([w.ravel(),b]),1:x},np.einsum('ik,jk->ij',x.astype('float64'),w.astype('float64'),optimize=False)+b,
            [rows,1,width,out,0,w.size],[math.ceil(rows*out/64),1],f'linear-{rows}-{width}-{out}')
for rows in [1,3,17]:
    x=random((rows,384));y=random(x.shape);scale=random(384);bias=random(384)
    value=x.astype('float64');mean=value.mean(axis=1,keepdims=True)
    norm=(value-mean)/np.sqrt(((value-mean)**2).mean(axis=1,keepdims=True)+1e-12)
    add('norm',{0:np.concatenate([scale,bias]),1:x},norm*scale+bias,[rows,1,0,0,0,384],[rows])
    add('add',{1:x,2:y},x.astype('float64')+y,[rows,1],[math.ceil(rows*384/64)])
for tokens in [2,15,16,17,31,32,33,127,128,129,511,512]:
    batch=2;q=random((batch,tokens,12,32));k=random(q.shape);v=random(q.shape)
    mask=np.ones((batch,tokens),dtype='<u4');mask[1,tokens//2:]=0
    score=np.einsum('bthd,bshd->bhts',q.astype('float64'),k.astype('float64'))/math.sqrt(32)
    score=np.where(mask[:,None,None,:],score,np.finfo('float32').min).astype('<f4')
    e=np.exp(score.astype('float64')-score.max(axis=-1,keepdims=True));probability=(e/e.sum(axis=-1,keepdims=True)).astype('<f4')
    add('scores',{1:q,2:k,6:mask},score,[tokens,batch],[math.ceil(tokens/64),tokens,batch*12])
    add('softmax',{4:score},probability,[tokens,batch],[tokens*batch,12])
    context=np.einsum('bhts,bshd->bthd',probability.astype('float64'),v.astype('float64'))
    add('context',{1:probability,2:v},context,[tokens,batch],[math.ceil(tokens*batch*384/64)])
    add('attention_fused',{1:q,2:k,3:v,6:mask},context,[tokens,batch],[tokens,batch*12])
    hidden=random((batch,tokens,384));pooled=hidden[:,0].astype('float64');pooled/=np.linalg.norm(pooled,axis=-1,keepdims=True)
    add('pool',{1:hidden},pooled,[tokens,batch],[batch])
x=np.linspace(-12,12,1536,dtype='<f4');expected=np.array([float(v)*0.5*(1+math.erf(float(v)/math.sqrt(2))) for v in x])
add('gelu',{4:x},expected,[1,1],[24])
word=random((64,384));position=random((17,384));types=random((2,384));ids=rng.integers(0,64,(2,17),dtype='<u4')
expected=(word[ids]+types[0])+position[np.arange(17)]
add('gather',{0:np.concatenate([word.ravel(),position.ravel(),types.ravel()]),5:ids},expected,
    [17,2,0,0,0,0,word.size,word.size+position.size],[math.ceil(2*17*384/64)])
(OUT/'manifest.json').write_text(json.dumps({'seed':1901,'oracle':'NumPy FP64 arithmetic and Python math.erf; output FP32','cases':cases},indent=2)+'\n')
print(f'Generated {len(cases)} independent GPU kernel fixtures')
