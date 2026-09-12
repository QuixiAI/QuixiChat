#!/usr/bin/env python3
"""Untruncated independent tokenizer oracle for the strict scheduler preflight."""
import argparse
import hashlib
import json
from runtime import Reference,QUERY_PREFIX
from fetch import ROOT


def generate():
    reference=Reference();reference.tokenizer.model_max_length=10**9
    texts=set()
    for directory in ['tests/goldens','tests/gpu/goldens']:
        for case in json.loads((ROOT/directory/'manifest.json').read_text())['cases']:
            texts.update((case['role'],text) for text in case['texts'])
    for role in ['document','query']:
        for content in [0,1,100,500,501,502,503,508,509,510,511,512,513,1000,10000]:
            for suffix in ['', ' \u0301\x00\ufffd', ' extra', '[MASK]']:
                texts.add((role,' '.join(['token']*content)+suffix))
        for text in ['a'*101, 'a'*1000, 'CAFÉ 中文 [MASK]', '\u0301'*1000, '𠮷'*520,
                     'representations '*520, '[MASK]'*512, '[UNK] [CLS] [SEP]']:
            texts.add((role,text))
    cases=[]
    for role,text in sorted(texts):
        raw=text.encode('utf-8');tokens=reference.tokenizer((QUERY_PREFIX if role=='query' else '')+text,truncation=False,padding=False)['input_ids']
        cases.append({'role':role,'text':text,'untruncated_tokens':len(tokens),'tokenCount':min(513,len(tokens)),
                      'overflow':len(tokens)>512,'inputSha256':hashlib.sha256(raw).hexdigest(),'ids':tokens[:511]+[102] if len(tokens)>512 else tokens})
    return {'version':1,'source_revision':reference.lock['revision'],'query_prefix':QUERY_PREFIX,'cases':cases}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--verify',action='store_true');args=parser.parse_args()
    output=ROOT/'tests/token-preflight-fixtures.json';result=generate()
    if args.verify:
        if json.loads(output.read_text())!=result:raise SystemExit('Strict preflight oracle differs')
    else:output.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
    print(f'{"Verified" if args.verify else "Generated"} {len(result["cases"])} untruncated preflight cases')
