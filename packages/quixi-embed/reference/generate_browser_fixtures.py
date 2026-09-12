#!/usr/bin/env python3
"""Derive compact browser-worker fixtures from the immutable numerical goldens."""
import argparse
import json
from pathlib import Path
import numpy as np
from fetch import ROOT,sha256


def generate(output,verify=False):
    path=ROOT/'tests/goldens/manifest.json';manifest=json.loads(path.read_text());fixtures=[]
    selected={'edge-documents','edge-queries','truncation-documents','truncation-queries'}
    for case in manifest['cases']:
        if case['id'] not in selected:continue
        source=ROOT/'tests/goldens'/case['file']
        if sha256(source)!=case['sha256']:raise ValueError('Golden integrity failure')
        with np.load(source,allow_pickle=False) as arrays:
            for row,text in enumerate(case['texts']):
                mask=arrays['attention_mask'][row].astype(bool)
                fixtures.append({'id':case['id']+'-'+str(row),'text':text,'role':case['role'],
                    'ids':arrays['input_ids'][row][mask].tolist(),'vector':arrays['vectors'][row].tolist()})
    result={'source':manifest['source']['revision'],'golden_manifest_sha256':sha256(path),'fixtures':fixtures}
    encoded=json.dumps(result,indent=2,ensure_ascii=False)+'\n'
    if verify:
        if output.read_text()!=encoded:raise ValueError('Browser fixtures differ from frozen goldens')
    else:
        output.parent.mkdir(parents=True,exist_ok=True);output.write_text(encoded)
    print(f'{"Verified" if verify else "Generated"} {len(fixtures)} browser fixtures')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'tests/browser-fixtures.json')
    parser.add_argument('--verify',action='store_true');args=parser.parse_args();generate(args.output,args.verify)
