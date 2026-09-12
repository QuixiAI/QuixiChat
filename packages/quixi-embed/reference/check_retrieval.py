#!/usr/bin/env python3
"""Compare actual native scalar retrieval against the frozen exact reference baseline."""
import argparse
import json
from pathlib import Path
import sys
import time
import subprocess
import numpy as np
from fetch import ROOT, sha256
from native_runtime import Native, DEFAULT_LIBRARY
from runtime import Reference
RETRIEVAL = ROOT.parents[1] / 'perf/retrieval'
sys.path.insert(0,str(RETRIEVAL))
from run import chunk_documents, CHUNKER
from metrics import evaluate, document_ranking


def check(output,route="native",engine="chromium",projection=None,attention="baseline"):
    projection = projection or ("half" if route == "gpu-fp16" else "baseline")
    if route.startswith("gpu-") and (projection == "half") != (route == "gpu-fp16"):
        raise ValueError("FP16 route and half projection must agree")
    if route not in ("native","scalar","simd","gpu-fp32","gpu-fp16"):raise ValueError("Unknown encoder route")
    documents=[json.loads(line) for line in (RETRIEVAL/'corpus.jsonl').read_text().splitlines()]
    queries=json.loads((RETRIEVAL/'queries.json').read_text())
    qrels=json.loads((RETRIEVAL/'qrels.json').read_text())
    baseline=json.loads((RETRIEVAL/'baseline.json').read_text())
    for name,expected in baseline['corpus']['files'].items():
        if sha256(RETRIEVAL/name)!=expected:raise ValueError('Corpus hash mismatch')
    reference=Reference()
    chunks=chunk_documents(documents,reference.tokenizer)
    begin=time.perf_counter()
    if route == 'native':
        native=Native()
        try:
            corpus_vectors=[]
            for index,chunk in enumerate(chunks):
                corpus_vectors.append(native.forward([chunk['text']],'document')['vectors'][0])
                if index%100==0:print(f'native corpus {index}/{len(chunks)}',flush=True)
            documents_native=np.stack(corpus_vectors)
            queries_native=native.forward([q['text'] for q in queries],'query')['vectors']
        finally:
            native.close()
    else:
        input_file=ROOT/f'build/{route}-retrieval-input.json'
        vector_file=ROOT/f'build/{route}-retrieval-vectors.bin'
        input_file.write_text(json.dumps([{'text':c['text'],'role':'document'} for c in chunks]+[{'text':q['text'],'role':'query'} for q in queries]))
        if route.startswith('gpu-'):
            subprocess.run(['node',str(ROOT/'reference/embed_gpu.mjs'),engine,str(input_file),str(vector_file),projection,attention],check=True)
        else:
            subprocess.run(['node','--experimental-strip-types',str(ROOT/'reference/embed_wasm.mjs'),route,str(input_file),str(vector_file)],check=True)
        vectors=np.fromfile(vector_file,dtype='<f4').reshape(len(chunks)+len(queries),384)
        documents_native=vectors[:len(chunks)];queries_native=vectors[len(chunks):]
    native_seconds=time.perf_counter()-begin
    documents_reference=reference.embed([c['text'] for c in chunks],'document')
    queries_reference=reference.embed([q['text'] for q in queries],'query')
    def rankings(q,d):
        scores=np.einsum('qd,nd->qn',q,d)
        return {query['id']:document_ranking(np.argsort(-scores[i],kind='stable'),chunks) for i,query in enumerate(queries)}
    actual=rankings(queries_native,documents_native);expected=rankings(queries_reference,documents_reference)
    metrics=evaluate(actual,qrels);reference_metrics=evaluate(expected,qrels)
    changed=[q for q in actual if actual[q][:10]!=expected[q][:10]]
    delta=max(float(np.abs(documents_native-documents_reference).max()),float(np.abs(queries_native-queries_reference).max()))
    quality=all(metrics['mean'][key]>=baseline['exact_fp32']['mean'][key]-1e-12 for key in ['recall@5','recall@10','mrr'])
    result={'passed':quality and not changed and delta<=(3e-3 if route=='gpu-fp16' else 8e-5 if route=='gpu-fp32' else 2e-5),'route':'native-c-scalar-fp32' if route=='native' else ('webgpu-fp16' if route=='gpu-fp16' else 'webgpu-fp32' if route.startswith('gpu-') else f'wasm-{route}-fp32'),'chunks':len(chunks),'queries':len(queries),
            'chunker':CHUNKER,'model_sha256':sha256(ROOT/'build/arctic-xs.qxmodel'),
            'library_sha256':sha256(DEFAULT_LIBRARY if route=='native' else ROOT/('kernels/webgpu/1.0.0/baseline.wgsl' if route.startswith('gpu-') else f'build/quixi-{route}.wasm')),
            'gpu':json.loads(Path(str(vector_file)+'.json').read_text()) if route.startswith('gpu-') else None,
            'baseline_sha256':sha256(RETRIEVAL/'baseline.json'),
            'maximum_vector_absolute_error':delta,'changed_top_ten_queries':changed,
            'native':metrics,'reference':reference_metrics,'execution_seconds':native_seconds,
            'limitations':'Small synthetic relevance corpus; no production compression or scale approval.'}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('native','reference')},indent=2))
    if not result['passed']:raise SystemExit(1)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--report',type=Path,default=ROOT/'build/native-retrieval-report.json')
    parser.add_argument('--route',choices=['native','scalar','simd','gpu-fp32','gpu-fp16'],default='native')
    parser.add_argument('--engine',choices=['chromium','webkit'],default='chromium')
    parser.add_argument('--projection',choices=['baseline','tiled','half','auto'])
    parser.add_argument('--attention',choices=['baseline','fused'],default='baseline')
    args=parser.parse_args();check(args.report,args.route,args.engine,args.projection,args.attention)
