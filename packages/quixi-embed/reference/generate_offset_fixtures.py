#!/usr/bin/env python3
"""Pinned fast-tokenizer original offsets, independently converted to UTF-8/UTF-16."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import struct
from transformers import AutoTokenizer
from fetch import ROOT, verify
from runtime import QUERY_PREFIX
CONTRIBUTORS = {case['text']: case for case in json.loads((ROOT / 'tests/token-offset-contributor-cases.json').read_text())['cases']}


def well_formed(text):
    # Matches TextEncoder replacement, while retaining original UTF-16 positions.
    return text.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace')


def boundaries(text):
    byte, utf16 = [0], [0]
    for char in text:
        byte.append(byte[-1] + len(char.encode('utf-8')))
        utf16.append(utf16[-1] + len(char.encode('utf-16-le')) // 2)
    return byte, utf16


def fixture(tokenizer, text, role):
    original = well_formed(text)
    prefix = QUERY_PREFIX if role == 'query' else ''
    encoded = tokenizer(prefix + original, truncation=False, padding=False,
                        return_offsets_mapping=True, return_special_tokens_mask=True)
    source_bytes, source_utf16 = boundaries(original)
    prefix_bytes, prefix_utf16 = boundaries(prefix)
    records = []
    for token, (start, end), special in zip(encoded['input_ids'], encoded['offset_mapping'], encoded['special_tokens_mask']):
        if special:
            records.extend([token, 0, 0, 0, 0, 2])
        elif start >= len(prefix):
            start -= len(prefix)
            end -= len(prefix)
            records.extend([token, source_bytes[start], source_bytes[end], source_utf16[start], source_utf16[end], 0])
        else:
            assert end <= len(prefix), 'Frozen prefix must not merge with source text'
            records.extend([token, prefix_bytes[start], prefix_bytes[end], prefix_utf16[start], prefix_utf16[end], 1])
    result = dict(text=text, role=role, inputBytes=source_bytes[-1], inputUtf16Units=source_utf16[-1],
                  tokenCount=len(encoded['input_ids']), records=records, offsetAuthority='upstream')
    manual = CONTRIBUTORS.get(text)
    if manual:
        assert tokenizer.backend_tokenizer.normalizer.normalize_str(original) == manual['normalized']
        assert ''.join(tokenizer.backend_tokenizer.normalizer.normalize_str(original[index]) for index in manual['contributorsCodepoints']) == manual['normalized']
        indices = [i for i in range(result['tokenCount']) if records[i * 6 + 5] == 0]
        assert [records[i * 6] for i in indices] == manual['contentIds']
        upstream = records.copy()
        for index, (start, end) in zip(indices, manual['sourceSpansCodepoints'], strict=True):
            records[index * 6 + 1:index * 6 + 5] = [source_bytes[start], source_bytes[end], source_utf16[start], source_utf16[end]]
        result['offsetAuthority'] = 'manual-contributors'
        if records != upstream:
            result['upstreamRecords'] = upstream
    return result


def focused_inputs():
    inputs = set()
    for directory in ['tests/goldens', 'tests/gpu/goldens']:
        for case in json.loads((ROOT / directory / 'manifest.json').read_text())['cases']:
            inputs.update((case['role'], text) for text in case['texts'])
    samples = ['', 'café', 'cafe\u0301', '\u0301abc', 'e\u0301x', 'a\x00b', 'ab\x00', '\x00ab', 'a\u200db',
               'İstanbul', '각각', 'x😀y', '𠮷', '[CLS]hi[MASK]', '[PAD][UNK][CLS][SEP][MASK]', '[U\x00NK]',
               'Straße', 'ﬃ', 'éclair', 'a\u0344b', 'a\r\nb', 'a\x1fb', '\u0345x', '\ufffe\uffff\ufffd',
               '\ud800', '\udc00', '\ud800\udc00', 'a\ud800b', '\ud800\ud800\udc00', '😀\udc00中',
               'a' * 100, 'a' * 101, 'a\u0301' * 101, '角' * 520, '각' * 200, 'token ' * 8192]
    for role in ['document', 'query']:
        inputs.update((role, text) for text in samples)
        inputs.update((role, text) for text in CONTRIBUTORS)
    randomizer = random.Random(20260908)
    alphabet = ['word', ' ', '\t', '\r\n', '\x00', '\u200d', '\u0301', '\u0345', 'İ', 'é', '각', '中', '𠮷', '😀', '[MASK]', '[CLS]', '-', 'ß', '\ufffd', '\ue000', '\ufffe']
    for index in range(512):
        inputs.add(('query' if index % 2 else 'document', ''.join(randomizer.choices(alphabet, k=randomizer.randrange(1, 40)))))
    return sorted(inputs)


def exhaustive_inputs():
    # Artifact tables select coverage only; every expected ID/span comes from the
    # independent pinned tokenizer and Python boundary maps, never from C output.
    artifact = (ROOT / 'build/arctic-xs.qxtokenizer').read_bytes()
    unicode_offset = struct.unpack_from('<Q', artifact, 40)[0]
    deleted, mapped, punctuated, _ = struct.unpack_from('<IIII', artifact, unicode_offset + 8)
    cursor = unicode_offset + 24
    deletion = set()
    for index in range(deleted):
        begin, end = struct.unpack_from('<II', artifact, cursor + index * 8)
        deletion.update(range(begin, end + 1))
    cursor += deleted * 8
    mappings = {struct.unpack_from('<I', artifact, cursor + index * 12)[0] for index in range(mapped)}
    cursor += mapped * 12
    punctuation = set()
    for index in range(punctuated):
        begin, end = struct.unpack_from('<II', artifact, cursor + index * 8)
        punctuation.update(range(begin, end + 1))
    boundaries_cjk = set()
    for begin, end in [(0x4e00, 0x9fff), (0x3400, 0x4dbf), (0x20000, 0x2a6df), (0x2a700, 0x2b73f),
                       (0x2b740, 0x2b81f), (0x2b820, 0x2ceaf), (0xf900, 0xfaff), (0x2f800, 0x2fa1f)]:
        boundaries_cjk.update([begin - 1, begin, begin + 1, end - 1, end, end + 1])
    values = sorted(deletion | mappings | punctuation | boundaries_cjk)
    inputs = []
    for start in range(0, len(values), 128):
        text = ''.join(chr(cp) + ' a' + chr(cp) + 'z ; ' for cp in values[start:start + 128])
        inputs.extend([(role, text) for role in ['document', 'query']])
    return inputs, dict(deletedScalars=len(deletion), normalizationMappings=len(mappings),
                        punctuationScalars=len(punctuation), cjkBoundaryScalars=len(boundaries_cjk),
                        uniqueScalars=len(values), occurrencesPerRole=2)


def generate(output, exhaustive=False, verify_existing=False):
    lock = verify(ROOT / 'build/source')
    tokenizer = AutoTokenizer.from_pretrained(ROOT / 'build/source', local_files_only=True, use_fast=True)
    tokenizer.model_max_length = 10**9
    inputs, coverage = exhaustive_inputs() if exhaustive else (focused_inputs(), {'focusedAndSeeded': True})
    header = dict(version=1, sourceRevision=lock['revision'], queryPrefix=QUERY_PREFIX,
                  oracle='Pinned fast-tokenizer IDs/offsets plus independent original UTF-8/UTF-16 boundaries; explicitly marked manual contributor spans for known upstream alignment anomalies',
                  cases=len(inputs), coverage=coverage)
    temporary = output.with_suffix(output.suffix + '.tmp')
    output.parent.mkdir(parents=True, exist_ok=True)
    with temporary.open('w') as stream:
        stream.write(json.dumps({'header': header}) + '\n')
        for role, text in inputs:
            stream.write(json.dumps(fixture(tokenizer, text, role), ensure_ascii=True, separators=(',', ':')) + '\n')
    if verify_existing:
        assert hashlib.sha256(output.read_bytes()).digest() == hashlib.sha256(temporary.read_bytes()).digest(), 'Offset oracle changed'
        temporary.unlink()
    else:
        temporary.replace(output)
    print(json.dumps({**header, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'bytes': output.stat().st_size}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exhaustive', action='store_true')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    generate(args.output or ROOT / ('build/token-offset-exhaustive.jsonl' if args.exhaustive else 'tests/token-offset-fixtures.jsonl'), args.exhaustive, args.verify)
