import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('quixi_perf',Path(__file__).resolve().parents[1]/'perf/summarize.py')
perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)


class PerformanceGateTest(unittest.TestCase):
    def report(self):
        measurements=[{'batch':b,'tokens':t,'maximum_vector_error':0,
            'scalar':{'samples_ms':[2]*30,'median_ms':2},'simd':{'samples_ms':[1]*30,'median_ms':1}}
            for b,t in sorted(perf.FULL)]
        return {'status':'passed','warmups':5,'samples':30,'measurements':measurements,
                'host':{},'assets':{},'load_ms':[1,1],'memory':[{},{}]}

    def check(self,report):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'report.json';path.write_text(json.dumps(report))
            return perf.summarize([path],require_full=True)

    def test_complete_raw_samples_pass(self):
        self.assertTrue(self.check(self.report())['full_matrix_exercised'])

    def test_partial_or_running_report_cannot_approve(self):
        report=self.report();report['status']='running'
        with self.assertRaises(ValueError):self.check(report)
        report=self.report();report['measurements'].pop()
        with self.assertRaises(ValueError):self.check(report)
        report=self.report();report['measurements'][0]['simd']['samples_ms'].pop()
        with self.assertRaises(ValueError):self.check(report)

    def test_numeric_drift_and_median_regression_fail(self):
        report=self.report();report['measurements'][0]['maximum_vector_error']=float('nan')
        with self.assertRaises(ValueError):self.check(report)
        report=self.report();report['measurements'][0]['simd']={'samples_ms':[3]*30,'median_ms':3}
        with self.assertRaises(ValueError):self.check(report)
        report=self.report();report['measurements'][0]['simd']['median_ms']=.5
        with self.assertRaises(ValueError):self.check(report)


if __name__=='__main__':unittest.main()
