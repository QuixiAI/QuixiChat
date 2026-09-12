#!/usr/bin/env python3
"""Validate saved paired full-encoder measurements and summarize retained performance."""
import argparse
import hashlib
import json
import math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
FULL={(batch,tokens) for batch in [1,4,8,16,32] for tokens in [32,128,512]}

def summarize(paths,require_full=False):
    hosts=[];has_full=False
    for path in paths:
        report=json.loads(path.read_text())
        if report['status']!='passed' or report['warmups']!=5 or report['samples']!=30:raise ValueError('Incomplete measurement protocol')
        seen=set();ratios=[]
        for row in report['measurements']:
            shape=(row['batch'],row['tokens'])
            if shape in seen:raise ValueError('Duplicate shape')
            seen.add(shape)
            if not math.isfinite(row['maximum_vector_error']) or row['maximum_vector_error']>5e-5:raise ValueError('Numerical benchmark gate')
            for route in ['scalar','simd']:
                values=row[route]['samples_ms']
                if len(values)!=30 or not all(math.isfinite(value) and value>0 for value in values):raise ValueError('Invalid timing samples')
                median=(sorted(values)[14]+sorted(values)[15])/2
                if not math.isclose(median,row[route]['median_ms'],rel_tol=1e-12):raise ValueError('Timing summary differs from raw samples')
            speedup=row['scalar']['median_ms']/row['simd']['median_ms']
            if speedup<1:raise ValueError(f'SIMD median regression at {shape} in {path}')
            ratios.append(speedup)
        if not seen:raise ValueError('Empty performance evidence')
        has_full|=seen==FULL
        hosts.append({'report':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'host':report['host'],
                      'full_matrix':seen==FULL,'shapes':len(seen),'minimum_speedup':min(ratios),'maximum_speedup':max(ratios),
                      'load_ms':report['load_ms'],'memory':report['memory'],'assets':report['assets']})
    if require_full and not has_full:raise ValueError('No complete 15-shape performance matrix')
    return {'passed':True,'full_matrix_exercised':has_full,'hosts':hosts,
            'limitations':'Measurements apply to named hardware/runtimes and ambient conditions; do not infer unmeasured OS/device results.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('reports',nargs='+',type=Path)
    parser.add_argument('--require-full',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/'build/simd-performance-summary.json')
    args=parser.parse_args();result=summarize(args.reports,args.require_full);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
