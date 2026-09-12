"""Public, synthetic fixtures; role is part of the correctness identity."""
BATCHES = [1, 4, 8, 16, 32]
LENGTHS = [2, 3, 7, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 511, 512]
ROUTES = ['scalar-fp32', 'wasm-simd-fp32', 'webgpu-fp32', 'webgpu-fp16']


def cases():
    yield {'id': 'edge-documents', 'role': 'document', 'texts': [
        '', 'Hi.', 'CAFÉ cafe\u0301 naïve Straße İSTANBUL',
        '中文 日本語 한국어 😀 👩\u200d💻', 'a\x00b\tline\nnext\ufffd',
        'def f(x):\n    return x != None and x >= 0 # code',
        '[CLS] literal [MASK] [SEP] [UNK] [PAD]', 'z' * 101,
    ], 'stages': True}
    yield {'id': 'edge-queries', 'role': 'query', 'texts': [
        '', 'Hi.', 'Where did we switch providers?', 'CAFÉ 中文 👩\u200d💻',
    ], 'stages': True}
    yield {'id': 'truncation-documents', 'role': 'document', 'texts': [
        'token ' * 510, 'token ' * 700,
    ], 'stages': True}
    yield {'id': 'truncation-queries', 'role': 'query', 'texts': [
        'token ' * 510, 'token ' * 700,
    ], 'stages': False}
    # Every role and batch size hits each sequence boundary. Shorter rows test
    # right padding; distinct token IDs prevent accidental broadcast passing.
    # Queries have a 8-token prompt and cannot exercise lengths below 10.
    for role in ('document', 'query'):
        prefix_tokens = 8 if role == 'query' else 0
        for length in LENGTHS:
            if length < prefix_tokens + 2:
                continue
            for batch in BATCHES:
                count = length - prefix_tokens - 2
                texts = []
                for i in range(batch):
                    word = ('token', 'hello', 'world', 'search')[i % 4]
                    texts.append((word + ' ') * max(0, count - (i % 3)))
                yield {'id': f'{role}-b{batch}-t{length}', 'role': role,
                       'texts': texts, 'stages': False, 'expected_shape': [batch, length]}
