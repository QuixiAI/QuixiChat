import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('offset_ci',Path(__file__).resolve().parents[1]/'native/offset_ci.py')
ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)


class OffsetCIReportTest(unittest.TestCase):
    def test_failed_fixture_check_replaces_stale_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'build').mkdir();output=root/'build/token-offset-ci.json'
            output.write_text('{"passed":true,"status":"passed"}')
            def run(command,**kwargs):
                current=json.loads(output.read_text());self.assertFalse(current['passed'])
                self.assertEqual(current['commands'][-1]['status'],'running')
                return subprocess.CompletedProcess(command,23 if any('generate_offset_fixtures.py' in value for value in command) else 0)
            with patch.object(ci,'ROOT',root),patch.object(ci.subprocess,'run',side_effect=run):
                with self.assertRaises(subprocess.CalledProcessError):ci.main(skip_provision=True)
            report=json.loads(output.read_text());self.assertFalse(report['passed']);self.assertEqual(report['status'],'failed')
            self.assertEqual(report['commands'][-1]['exitCode'],23);self.assertEqual(report['failedCommand'],report['commands'][-1]['command'])
            self.assertIn('finishedAt',report)

    def test_launch_failure_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with patch.object(ci,'ROOT',root),patch.object(ci.subprocess,'run',side_effect=FileNotFoundError('missing compiler')):
                with self.assertRaises(FileNotFoundError):ci.main(skip_provision=True)
            report=json.loads((root/'build/token-offset-ci.json').read_text())
            self.assertFalse(report['passed']);self.assertEqual(report['commands'][0]['status'],'failed');self.assertIn('missing compiler',report['error'])


if __name__=='__main__':unittest.main()
