#!/usr/bin/env python3
"""Compare C WordPiece against frozen fast-tokenizer for every Unicode scalar."""
import argparse
import ctypes as C
import json
import hashlib
from pathlib import Path
import random
import time
from tokenizers import Tokenizer
from fetch import ROOT, sha256
from native_runtime import PRODUCTION_LIBRARY


def check(report, exhaustive=True):
    library=PRODUCTION_LIBRARY;lib=C.CDLL(str(library))
    lib.qx_tokenizer_load.argtypes=[C.c_void_p,C.c_size_t,C.POINTER(C.c_int)];lib.qx_tokenizer_load.restype=C.c_void_p
    lib.qx_tokenizer_encode.argtypes=[C.c_void_p,C.c_void_p,C.c_size_t,C.c_uint32,C.c_void_p,C.POINTER(C.c_uint32)]
    lib.qx_tokenizer_free.argtypes=[C.c_void_p]
    source=(ROOT/'build/arctic-xs.qxtokenizer').read_bytes();status=C.c_int()
    handle=lib.qx_tokenizer_load(source,len(source),C.byref(status));assert handle,status.value
    reference=Tokenizer.from_file(str(ROOT/'build/source/tokenizer.json'))
    ids=(C.c_uint32*512)();count=C.c_uint32();cases=0;begin=time.perf_counter()
    def compare(text):
        nonlocal cases
        encoded=text.encode('utf-8')
        code=lib.qx_tokenizer_encode(handle,encoded,len(encoded),0,ids,C.byref(count))
        expected=reference.encode(text).ids;actual=list(ids[:count.value])
        if code or expected!=actual:
            raise AssertionError({'text':repr(text),'expected':expected,'actual':actual,'status':code})
        cases+=1
    try:
        if exhaustive:
            for cp in range(0x110000):
                if 0xd800<=cp<=0xdfff:continue
                char=chr(cp);compare(char);compare('a'+char+'b')
        focused=['ΟΣ','İ\u0301','a\u0301b','a[CLS]b[MASK]','[cls][UNK]','\ue000\u0378',
                 '\u2003\u2009\u202f','中文兀','가각갂','z'*100,'z'*101,'abc\x00def',
                 '👩\u200d💻','e\u0301\u0327','[PAD] [MASK] [SEP] [CLS]', 'token '*700]
        for text in focused:compare(text)
        randomizer=random.Random(1701)
        alphabet='aAßΣİé中文가\u0301\u200d \n.,[]#0123😀\ue000\u0378'
        for _ in range(5000):compare(''.join(randomizer.choices(alphabet,k=randomizer.randrange(0,200))))
    finally:
        lib.qx_tokenizer_free(handle)
    result={'passed':True,'exhaustive_unicode_scalars':exhaustive,'cases':cases,
            'contexts':['single scalar','ASCII word around scalar','focused normalization/special cases','5000 seeded mixed strings'],
            'elapsed_seconds':time.perf_counter()-begin,'library_sha256':sha256(library),
            'tokenizer_artifact_sha256':hashlib.sha256(source).hexdigest()}
    report.parent.mkdir(parents=True,exist_ok=True);report.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--quick',action='store_true')
    parser.add_argument('--report',type=Path,default=ROOT/'build/unicode-report.json')
    args=parser.parse_args();check(args.report,not args.quick)
