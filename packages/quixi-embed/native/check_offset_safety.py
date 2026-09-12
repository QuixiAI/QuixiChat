#!/usr/bin/env python3
"""Exercise offset ABI capacity/overflow/UTF-8/lifetimes under ASan and UBSan."""
import json
from pathlib import Path
import subprocess
from build import ROOT, VERSION
from fetch import sha256

output=ROOT/'build/qx-offset-safety'
report_path=ROOT/'build/token-offset-safety.json'
sources=[ROOT/'native'/name for name in ['model.c','tokenizer.c','encoder.c','sha256.c']]+[ROOT/'tests/token-offset-safety.c']
command=['clang','-std=c11','-O1','-g','-ffp-contract=off','-fno-vectorize','-fno-slp-vectorize',
         '-fsanitize=address,undefined','-fno-omit-frame-pointer','-Wall','-Wextra','-Werror',*[str(x) for x in sources],'-lm','-o',str(output)]
report=dict(status='running',passed=False,artifactVersion=VERSION,command=command)
report_path.write_text(json.dumps(report,indent=2)+'\n')
try:
    subprocess.run(command,check=True)
    subprocess.run([output,ROOT/'build/arctic-xs.qxtokenizer'],check=True)
    report.update(status='passed',passed=True,binarySha256=sha256(output),sources={str(x.relative_to(ROOT)):sha256(x) for x in sources},
                  sanitizers=['address','undefined'],maxRecords=65536,maxInputBytes=1048576,
                  invalidCapacityAndUtf8=True,exactRequiredCounts=True,outputCanaries=True)
except BaseException as error:
    report.update(status='failed',error=str(error));raise
finally:
    report_path.write_text(json.dumps(report,indent=2)+'\n')
