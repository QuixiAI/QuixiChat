import tempfile
import unittest
from pathlib import Path
import numpy as np
from runtime import Reference, QUERY_PREFIX
from fetch import verify


class ReferenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reference = Reference()

    def test_prefix_and_special_tokens(self):
        reference = self.reference
        self.assertEqual(reference.tokenize([''], 'document')['input_ids'].tolist(), [[101, 102]])
        prefix = reference.tokenizer(QUERY_PREFIX, add_special_tokens=False)['input_ids']
        self.assertEqual(prefix, [5050, 2023, 6251, 2005, 6575, 7882, 13768, 1024])
        self.assertEqual(reference.tokenize([''], 'query')['input_ids'].tolist(), [[101] + prefix + [102]])

    def test_padding_invariance_and_roles(self):
        reference = self.reference
        solo = reference.forward(['Hello'], 'document')['vectors'][0]
        batch = reference.forward(['Hello', 'This is a longer document with padding.'], 'document')
        self.assertTrue(np.allclose(solo, batch['vectors'][0], atol=1e-6, rtol=1e-5))
        self.assertEqual(batch['attention_mask'][0].tolist()[:3], [1, 1, 1])
        self.assertTrue((batch['attention_mask'][0, 3:] == 0).all())
        self.assertFalse(np.allclose(solo, reference.forward(['Hello'], 'query')['vectors'][0]))

    def test_right_truncation_preserves_sep(self):
        result = self.reference.tokenize(['token ' * 510, 'token ' * 700], 'document')
        self.assertEqual(tuple(result['input_ids'].shape), (2, 512))
        self.assertTrue(np.array_equal(result['input_ids'][0], result['input_ids'][1]))
        self.assertEqual(result['input_ids'][0, -1].item(), 102)

    def test_bad_source_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'integrity failure'):
                verify(Path(directory))

    def test_invalid_role_rejected(self):
        with self.assertRaises(ValueError):
            self.reference.tokenize(['hello'], 'unknown')


if __name__ == '__main__':
    unittest.main()
