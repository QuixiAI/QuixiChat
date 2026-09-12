import unittest
from metrics import evaluate, candidate_recall, document_ranking


class MetricsTest(unittest.TestCase):
    def test_known_multiple_relevance_and_missing_hits(self):
        result = evaluate({'q1': ['x', 'a', 'y', 'b'], 'q2': ['x']},
                          {'q1': {'a': 2, 'b': 1, 'x': 0}, 'q2': {'c': 1}})
        self.assertEqual(result['mean']['recall@5'], 0.5)
        self.assertEqual(result['mean']['mrr'], 0.25)

    def test_coarse_metric_is_not_judged_recall(self):
        self.assertEqual(candidate_recall(['d', 'a'], ['a', 'b', 'c'], 3), 1 / 3)
        self.assertEqual(candidate_recall(['a'], ['a'], 500), 1)

    def test_chunk_dedup_preserves_best_document_rank(self):
        self.assertEqual(document_ranking([2, 0, 1], [{'document_id': 'a'},
                         {'document_id': 'b'}, {'document_id': 'a'}]), ['a', 'b'])

    def test_invalid_coverage_and_duplicates(self):
        for rankings, qrels in [({}, {}), ({'q': ['a', 'a']}, {'q': {'a': 1}}),
                                ({'q': []}, {'q': {}}), ({}, {'q': {'a': 1}})]:
            with self.assertRaises(ValueError):
                evaluate(rankings, qrels)


if __name__ == '__main__':
    unittest.main()
