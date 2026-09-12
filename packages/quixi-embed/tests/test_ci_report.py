import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('quixi_ci',Path(__file__).resolve().parents[1]/'native/ci.py')
ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)


class CIReportTest(unittest.TestCase):
    def test_preflight_failure_replaces_stale_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'build').mkdir();path=root/'build/ci-report.json'
            path.write_text('{"passed": true, "status": "passed"}')
            with patch.object(ci,'ROOT',root),patch.object(ci.shutil,'which',return_value=None):
                with self.assertRaisesRegex(RuntimeError,'missing'):
                    ci.main()
            report=json.loads(path.read_text());self.assertFalse(report['passed']);self.assertEqual(report['status'],'failed')
            self.assertIn('finished_at',report)

    def test_failed_command_records_exit_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'build/ci-report.json'
            def fail(command,**kwargs):
                in_progress=json.loads(path.read_text())
                self.assertFalse(in_progress['passed']);self.assertEqual(in_progress['commands'][-1]['status'],'running')
                return subprocess.CompletedProcess(command,17)
            with patch.object(ci,'ROOT',root),patch.object(ci.shutil,'which',return_value='/tool'),patch.object(ci.subprocess,'run',side_effect=fail):
                with self.assertRaises(subprocess.CalledProcessError):ci.main()
            report=json.loads(path.read_text());self.assertFalse(report['passed']);self.assertEqual(report['exit_code'],17)
            self.assertEqual(report['commands'][0]['exit_code'],17);self.assertEqual(report['commands'][0]['status'],'failed')
            self.assertEqual(report['failed_command'],report['commands'][0]['command'])

    def test_simd_provisioning_requires_no_desktop_native_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);commands=[];requested_tools=[]
            def which(tool):requested_tools.append(tool);return '/tool'
            def success(command,**kwargs):commands.append(command);return subprocess.CompletedProcess(command,0)
            with patch.object(ci,'ROOT',root),patch.object(ci.shutil,'which',side_effect=which),patch.object(ci.subprocess,'run',side_effect=success):
                ci.main(full=True,browsers=True,simd=True)
            report=json.loads((root/'build/ci-simd-report.json').read_text())
            self.assertTrue(report['passed']);self.assertNotIn('clang',requested_tools)
            self.assertFalse(any('--target' in command and 'native' in command for command in commands))
            self.assertTrue(any('wasm-simd-fp32' in command for command in commands))
            self.assertTrue(any(str(root/'native/release.py') in command for command in commands))


if __name__=='__main__':unittest.main()
