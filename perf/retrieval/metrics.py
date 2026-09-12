"""Pure reference metrics. Ranked IDs are unique source documents, not chunks."""
import math


def evaluate(rankings, qrels):
    if set(rankings) != set(qrels) or not qrels:
        raise ValueError('rankings must cover exactly the nonempty judged query set')
    rows = {}
    for query, judgments in qrels.items():
        relevant = {doc for doc, grade in judgments.items() if grade > 0}
        if not relevant:
            raise ValueError(f'query has no relevant documents: {query}')
        ranking = rankings[query]
        if len(set(ranking)) != len(ranking):
            raise ValueError(f'duplicate ranked document for {query}')
        row = {f'recall@{k}': len(set(ranking[:k]) & relevant) / len(relevant) for k in [5, 10, 100, 500]}
        row['mrr'] = next((1 / rank for rank, doc in enumerate(ranking, 1) if doc in relevant), 0.0)
        rows[query] = row
    return {'mean': {key: math.fsum(row[key] for row in rows.values()) / len(rows)
                     for key in next(iter(rows.values()))}, 'per_query': rows}


def candidate_recall(candidates, exact, k):
    """Chunk candidate overlap with exact top-k, separate from relevance judgments."""
    if k <= 0 or len(exact) == 0:
        raise ValueError('positive k and nonempty exact ranking required')
    truth = set(exact[:k])
    return len(set(candidates) & truth) / len(truth)


def document_ranking(chunk_indices, chunks):
    return list(dict.fromkeys(chunks[int(i)]['document_id'] for i in chunk_indices))
