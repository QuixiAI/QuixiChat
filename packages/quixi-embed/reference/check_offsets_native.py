#!/usr/bin/env python3
"""Compare native C original offsets with the independent streaming JSONL oracle."""
import argparse
import ctypes
import json
from pathlib import Path
from fetch import ROOT, sha256
from generate_offset_fixtures import well_formed
from native_runtime import PRODUCTION_LIBRARY


def check(fixtures, report_path):
    report = dict(passed=False, status='running', cases=0, manualContributorCases=0, upstreamOffsetDivergences=0, fixtureSha256=sha256(fixtures), librarySha256=sha256(PRODUCTION_LIBRARY))
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    lib = ctypes.CDLL(str(PRODUCTION_LIBRARY))
    lib.qx_tokenizer_load.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_int)]
    lib.qx_tokenizer_load.restype = ctypes.c_void_p
    lib.qx_tokenizer_encode_offsets.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
    lib.qx_tokenizer_free.argtypes = [ctypes.c_void_p]
    blob = (ROOT / 'build/arctic-xs.qxtokenizer').read_bytes()
    status = ctypes.c_int()
    tokenizer = lib.qx_tokenizer_load(blob, len(blob), ctypes.byref(status))
    assert status.value == 0 and tokenizer
    storage = (ctypes.c_uint32 * (65536 * 6 + 2))()
    try:
        with fixtures.open() as stream:
            header = json.loads(next(stream))['header']
            report['coverage'] = header['coverage']
            for line in stream:
                case = json.loads(line)
                report['manualContributorCases'] += case.get('offsetAuthority') == 'manual-contributors'
                report['upstreamOffsetDivergences'] += 'upstreamRecords' in case
                capacity = case['tokenCount']
                assert 2 <= capacity <= 65536
                storage[0] = storage[capacity * 6 + 1] = 0xa5a5a5a5
                count = ctypes.c_uint32()
                raw = well_formed(case['text']).encode('utf-8')
                code = lib.qx_tokenizer_encode_offsets(tokenizer, raw, len(raw), int(case['role'] == 'query'), ctypes.byref(storage, 4), capacity, ctypes.byref(count))
                assert code == 0 and count.value == capacity, (report['cases'], code, count.value, capacity)
                actual = list(storage[1:1 + count.value * 6])
                assert actual == case['records'], (report['cases'], repr(case['text']), actual[:60], case['records'][:60])
                assert storage[0] == storage[capacity * 6 + 1] == 0xa5a5a5a5
                if capacity > 2:
                    storage[13] = 0xa5a5a5a5
                    code = lib.qx_tokenizer_encode_offsets(tokenizer, raw, len(raw), int(case['role'] == 'query'), ctypes.byref(storage, 4), 2, ctypes.byref(count))
                    assert code == 2 and count.value == capacity and storage[13] == 0xa5a5a5a5
                report['cases'] += 1
            assert report['cases'] == header['cases']
        report.update(passed=True, status='passed', exactRequiredCountOnRejection=True, outputCanariesPreserved=True)
    except BaseException as error:
        report.update(status='failed', error=str(error))
        raise
    finally:
        lib.qx_tokenizer_free(tokenizer)
        report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, default=ROOT / 'tests/token-offset-fixtures.jsonl')
    parser.add_argument('--report', type=Path, default=ROOT / 'build/token-offset-native.json')
    args = parser.parse_args()
    check(args.fixtures, args.report)
