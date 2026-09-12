import copy
import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('gpu_perf',ROOT/'perf/check_gpu.py')
checker=importlib.util.module_from_spec(spec);spec.loader.exec_module(checker)


class GPUPerformanceEvidenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.measured=json.loads((ROOT/'perf/results/2026-09-08-gpu-development-load/baseline-vs-tiled-chromium.json').read_text())

    def test_archived_raw_matrix(self):self.assertTrue(checker.validate(self.measured)['passed'])

    def test_incomplete_and_corrupted_measurements_are_rejected(self):
        mutations=[lambda r:r.update(status='running'),lambda r:r['shapes'].pop(),
            lambda r:r['shapes'][0]['samples']['baseline'].pop(),
            lambda r:r['shapes'][0]['samples']['baseline'].__setitem__(0,float('nan')),
            lambda r:r['shapes'][0]['metrics']['baseline'].update(medianMs=0),
            lambda r:r['shapes'][0].update(maxError=1,speedup=999)]
        for mutate in mutations:
            report=copy.deepcopy(self.measured);mutate(report)
            self.assertFalse(checker.validate(report)['passed'])


if __name__=='__main__':unittest.main()
