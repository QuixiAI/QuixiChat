import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('gpu_ci',Path(__file__).resolve().parents[1]/'native/gpu_ci.py')
ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)


class GPUCIReportTest(unittest.TestCase):
    def test_failed_hardware_probe_cannot_leave_stale_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'build').mkdir();path=root/'build/gpu-ci-report.json'
            path.write_text('{"passed":true,"status":"passed"}')
            def run(command,**kwargs):
                current=json.loads(path.read_text())
                self.assertFalse(current['passed']);self.assertEqual(current['commands'][-1]['status'],'running')
                return subprocess.CompletedProcess(command,23 if any('probe.mjs' in value for value in command) else 0)
            with patch.object(ci,'ROOT',root),patch.object(ci.subprocess,'run',side_effect=run):
                with self.assertRaises(subprocess.CalledProcessError):ci.main(['chromium'],skip_provision=True)
            report=json.loads(path.read_text())
            self.assertFalse(report['passed']);self.assertEqual(report['status'],'failed')
            self.assertEqual(report['commands'][-1]['exit_code'],23)
            self.assertEqual(report['failed_command'],report['commands'][-1]['command'])
            self.assertIn('finished_at',report)

    def test_process_launch_failure_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.object(ci,'ROOT',root),patch.object(ci.subprocess,'run',side_effect=FileNotFoundError('missing tool')):
                with self.assertRaises(FileNotFoundError):ci.main(['webkit'],skip_provision=True)
            report=json.loads((root/'build/gpu-ci-report.json').read_text())
            self.assertFalse(report['passed']);self.assertIn('missing tool',report['error'])
            self.assertEqual(report['commands'][0]['status'],'failed')


if __name__=='__main__':unittest.main()
