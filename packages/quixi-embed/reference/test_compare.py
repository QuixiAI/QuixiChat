import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from compare import compare
from fetch import sha256


class ComparatorTest(unittest.TestCase):
    def write_case(self, directory, *, vector=None, ids=None, omit_stage=False):
        directory.mkdir(exist_ok=True)
        arrays = {'input_ids': np.array([[101, 102]] if ids is None else ids, dtype=np.int64),
                  'attention_mask': np.array([[1, 1]], dtype=np.int64),
                  'token_type_ids': np.array([[0, 0]], dtype=np.int64),
                  'pooled': np.array([[1.0, 0.0]], dtype=np.float32),
                  'vectors': np.array([[1.0, 0.0]] if vector is None else vector, dtype=np.float32)}
        if not omit_stage:
            arrays['stage_0'] = np.zeros((1, 2, 2), dtype=np.float32)
        path = directory / 'one.npz'
        np.savez_compressed(path, **arrays)
        manifest = {'source': {'revision': 'test'}, 'cases': [{'id': 'one', 'texts': [''],
                    'role': 'document', 'file': 'one.npz', 'sha256': sha256(path)}]}
        (directory / 'manifest.json').write_text(json.dumps(manifest))

    def test_self_reproduction_and_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / 'a', Path(tmp) / 'b'
            self.write_case(a)
            self.write_case(b)
            self.assertTrue(compare(a, b, 'scalar-fp32')['passed'])
            self.write_case(b, vector=[[float('nan'), 0]])
            self.assertFalse(compare(a, b, 'scalar-fp32')['passed'])
            self.write_case(b, vector=[[0, 1]])
            self.assertFalse(compare(a, b, 'scalar-fp32')['passed'])
            self.write_case(b, ids=[[101, 103]])
            self.assertFalse(compare(a, b, 'scalar-fp32')['passed'])

    def test_missing_stage_and_case_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / 'a', Path(tmp) / 'b'
            self.write_case(a)
            self.write_case(b, omit_stage=True)
            with self.assertRaisesRegex(ValueError, 'stage arrays'):
                compare(a, b, 'scalar-fp32')
            manifest = json.loads((b / 'manifest.json').read_text())
            manifest['cases'] = []
            (b / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'every golden case'):
                compare(a, b, 'scalar-fp32')


if __name__ == '__main__':
    unittest.main()
