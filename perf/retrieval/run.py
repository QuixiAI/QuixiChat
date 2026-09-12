#!/usr/bin/env python3
"""Measure exact FP32 and binary coarse retrieval using the frozen offline oracle."""
import argparse
import hashlib
import json
from pathlib import Path
import resource
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parent
REFERENCE = ROOT.parents[1] / 'packages/quixi-embed/reference'
sys.path.insert(0, str(REFERENCE))
from runtime import Reference, environment
from fetch import sha256
import numpy as np
from metrics import evaluate, candidate_recall, document_ranking

CHUNKER = {'id': 'reference-wordpiece-window-v1', 'max_content_tokens': 256,
           'overlap_tokens': 32, 'coordinate_unit': 'python-unicode-codepoint',
           'note': 'Reference benchmark adapter; production shared SearchChunk parity is a later integration gate.'}


def chunk_documents(documents, tokenizer):
    chunks = []
    for document in documents:
        offsets = tokenizer(document['text'], add_special_tokens=False, truncation=False,
                            return_offsets_mapping=True, verbose=False)['offset_mapping']
        for start in range(0, len(offsets), 224):
            window = offsets[start:start + 256]
            begin, end = window[0][0], window[-1][1]
            chunks.append({'id': f"{document['id']}:{begin}:{end}", 'document_id': document['id'],
                           'text': document['text'][begin:end], 'start': begin, 'end': end})
            if start + 256 >= len(offsets):
                break
    return chunks


def distribution(values):
    return {'samples': len(values), 'min_ms': min(values), 'median_ms': statistics.median(values),
            'p95_ms': float(np.percentile(values, 95)), 'max_ms': max(values)}


def measure(reference, output, performance=True):
    corpus_manifest = json.loads((ROOT / 'corpus-manifest.json').read_text())
    for name, expected in corpus_manifest['files'].items():
        if sha256(ROOT / name) != expected:
            raise ValueError(f'Corpus integrity failure: {name}')
    documents = [json.loads(line) for line in (ROOT / 'corpus.jsonl').read_text().splitlines()]
    queries = json.loads((ROOT / 'queries.json').read_text())
    qrels = json.loads((ROOT / 'qrels.json').read_text())
    chunks = chunk_documents(documents, reference.tokenizer)
    texts = [chunk['text'] for chunk in chunks]
    begin = time.perf_counter()
    vectors = reference.embed(texts, 'document')
    corpus_embedding_ms = (time.perf_counter() - begin) * 1000
    begin = time.perf_counter()
    query_vectors = reference.embed([q['text'] for q in queries], 'query')
    query_embedding_ms = (time.perf_counter() - begin) * 1000
    scores = np.einsum('qd,nd->qn', query_vectors, vectors)
    if not np.isfinite(scores).all():
        raise ValueError('Reference returned nonfinite scores')
    rankings, binary_rankings, reranked = {}, {}, {}
    overlap = {100: [], 500: []}
    exact_latency, coarse_latency = [], []
    per_query = []
    # One sign bit per dimension: demonstration baseline only. No compressed
    # production route is approved by a good score on this synthetic corpus.
    binary_documents = vectors >= 0
    for row, query in enumerate(queries):
        exact = np.argsort(-scores[row], kind='stable')
        sign = query_vectors[row] >= 0
        hamming = np.count_nonzero(binary_documents != sign, axis=1)
        coarse = np.argsort(hamming, kind='stable')
        candidate = coarse[:500]
        rerank = candidate[np.argsort(-scores[row, candidate], kind='stable')]
        rankings[query['id']] = document_ranking(exact, chunks)
        binary_rankings[query['id']] = document_ranking(coarse, chunks)
        reranked[query['id']] = document_ranking(rerank, chunks)
        for k in overlap:
            overlap[k].append(candidate_recall(coarse[:k], exact, k))
        per_query.append({'id': query['id'], 'top10_exact': rankings[query['id']][:10],
                          'top10_reranked': reranked[query['id']][:10]})
        # Warm data and sorting, seven measured repetitions per query. Scores
        # are recomputed in the timed region; corpus embedding is separate.
        for _ in range(7):
            begin = time.perf_counter()
            np.argsort(-np.einsum('nd,d->n', vectors, query_vectors[row]), kind='stable')
            exact_latency.append((time.perf_counter() - begin) * 1000)
            begin = time.perf_counter()
            np.argsort(np.count_nonzero(binary_documents != sign, axis=1), kind='stable')[:500]
            coarse_latency.append((time.perf_counter() - begin) * 1000)
    batch_measurements = []
    if performance:
        for length in [32, 128, 512]:
            for batch in [1, 4, 8, 16, 32]:
                texts = [('token ' * (length - 2)) for _ in range(batch)]
                reference.forward(texts, 'document')
                samples = []
                for _ in range(3):
                    begin = time.perf_counter()
                    reference.forward(texts, 'document')
                    samples.append((time.perf_counter() - begin) * 1000)
                median = statistics.median(samples)
                batch_measurements.append({'batch': batch, 'tokens_per_sequence': length,
                    'latency': distribution(samples), 'chunks_per_second': batch * 1000 / median,
                    'tokens_per_second': batch * length * 1000 / median})
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_bytes = rss if sys.platform == 'darwin' else rss * 1024
    report = {'version': 1, 'environment': environment(), 'host_load_controlled': False, 'model': reference.lock,
              'corpus': corpus_manifest, 'chunker': CHUNKER,
              'chunks': len(chunks), 'dimensions': int(vectors.shape[1]),
              'numeric_gate': 'Not evaluated here; use reference/compare.py separately.',
              'exact_fp32': evaluate(rankings, qrels),
              'binary_sign': evaluate(binary_rankings, qrels),
              'binary_500_then_fp32': evaluate(reranked, qrels),
              'binary_candidate_overlap_with_exact_chunks':
                  {f'recall@{k}': statistics.mean(values) for k, values in overlap.items()},
              'timing': {'cold_load_ms': reference.cold_load_ms,
                         'corpus_embedding_ms': corpus_embedding_ms, 'query_embedding_ms': query_embedding_ms,
                         'exact_scan_and_sort': distribution(exact_latency),
                         'binary_scan_and_sort': distribution(coarse_latency), 'batches': batch_measurements},
              'memory': {'process_peak_rss_bytes': peak_bytes, 'fp32_vectors_bytes': vectors.nbytes,
                         'packed_sign_vectors_bytes': int(np.packbits(binary_documents, axis=1).nbytes),
                         'note': 'RSS includes Python/framework/model, tokenization, and allocator caches. Not WASM or GPU memory.'},
              'per_query': per_query,
              'unmeasured_routes': ['wasm-simd-fp32', 'webgpu-fp32', 'webgpu-fp16'],
              'limitations': ['Synthetic English-focused smoke corpus; not a representative population.',
                              'Three CPU timing samples per batch are preliminary, not optimization acceptance.',
                              'No production compression choice, GPU dispatch/readback result, or scale claim follows.']}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'report': str(output), 'chunks': len(chunks),
                      'exact': report['exact_fp32']['mean'],
                      'binary_candidates': report['binary_candidate_overlap_with_exact_chunks']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'baseline.json')
    parser.add_argument('--source', type=Path)
    parser.add_argument('--skip-performance', action='store_true')
    args = parser.parse_args()
    measure(Reference(args.source), args.output, not args.skip_performance)
