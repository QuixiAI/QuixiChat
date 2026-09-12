#!/usr/bin/env python3
"""Check completed paired GPU measurement evidence; never regenerate samples."""
import argparse
import json
import math
from pathlib import Path
import statistics


def validate(report):
    errors=[]
    def require(condition,message):
        if not condition:errors.append(message)
    require(report.get('passed') is True and report.get('status')=='passed','run is not complete')
    protocol=report.get('protocol',{})
    require(protocol.get('warmups')==5 and protocol.get('samples')==30 and protocol.get('alternating') is True,'wrong paired sampling protocol')
    shapes=report.get('shapes',[])
    expected={(b,t) for b in ([1] if len(shapes)==3 else [1,4,8,16,32]) for t in [32,128,512]}
    require(len(shapes)==len(expected) and {(s.get('batch'),s.get('tokens')) for s in shapes}==expected,'incomplete or duplicate shape matrix')
    for shape in shapes:
        label=f"b{shape.get('batch')}-t{shape.get('tokens')}"
        samples=shape.get('samples',{})
        require(len(samples)==2,label+': not two paired routes')
        limit=3e-3 if any('half' in route for route in samples) else 8e-5
        error=shape.get('maxError',float('inf'))
        require(isinstance(error,(int,float)) and math.isfinite(error) and 0<=error<=limit,label+': numerical gate')
        medians=[]
        for route,values in samples.items():
            valid=len(values)==30 and all(isinstance(v,(float,int)) and math.isfinite(v) and v>0 for v in values)
            require(valid,label+': invalid raw samples '+route)
            if not valid:continue
            median=statistics.median(values);medians.append(median)
            metrics=shape.get('metrics',{}).get(route,{})
            require(math.isclose(metrics.get('medianMs',-1),median,rel_tol=1e-10),label+': median mismatch '+route)
            require(math.isclose(metrics.get('p95Ms',-1),sorted(values)[28],rel_tol=1e-10),label+': p95 mismatch '+route)
        if len(medians)==2:require(math.isclose(shape.get('speedup',-1),medians[0]/medians[1],rel_tol=1e-10),label+': speedup mismatch')
    return {'passed':not errors,'shapes':len(shapes),'errors':errors}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('reports',type=Path,nargs='+');parser.add_argument('--report',type=Path)
    args=parser.parse_args();results={str(path):validate(json.loads(path.read_text())) for path in args.reports}
    output={'passed':all(r['passed'] for r in results.values()),'reports':results}
    if args.report:args.report.write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps(output,indent=2));raise SystemExit(0 if output['passed'] else 1)
