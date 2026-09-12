"""Check the built callback through a local, cached nginx image; never pull/publish."""
import argparse
import hashlib
import json
import pathlib
import platform
import subprocess
import time
import urllib.request
import uuid
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True, help='An already-local image containing nginx')
parser.add_argument('--output', default='docs/validation/results/browser-oauth-deployment-macos.json')
args = parser.parse_args()
name = 'quixi-oauth-headers-' + str(uuid.uuid4())
marker = 'synthetic-callback-query-' + str(uuid.uuid4())
report = {'status': 'failed', 'startedAt': datetime.now(timezone.utc).isoformat(),
          'platform': platform.platform(), 'checks': [], 'scope': 'Built static callback served by local cached nginx over loopback HTTP. No public proxy, TLS, provider or release-image build claim.'}

def command(*argv):
    return subprocess.check_output(argv, text=True, stderr=subprocess.STDOUT, timeout=45).strip()

def check(condition, label):
    if not condition:
        raise RuntimeError(label)
    report['checks'].append(label)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

try:
    image_id = command('docker', 'image', 'inspect', args.image, '--format', '{{.Id}}')
    report['imageId'] = image_id
    command('docker', 'run', '--detach', '--rm', '--pull', 'never', '--name', name,
            '--read-only', '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run', '--tmpfs', '/tmp',
            '--publish', '127.0.0.1::8080',
            '--mount', f'type=bind,source={ROOT / "apps/web/dist"},target=/usr/share/nginx/html,readonly',
            '--mount', f'type=bind,source={ROOT / "deploy/docker/nginx.conf"},target=/etc/nginx/conf.d/default.conf,readonly',
            image_id)
    address = command('docker', 'port', name, '8080/tcp')
    check(address.startswith('127.0.0.1:'), 'Server is published only on loopback')
    base = 'http://' + address
    for attempt in range(50):
        try:
            with urllib.request.urlopen(base + '/', timeout=1) as response:
                response.read(1024)
                break
        except OSError:
            if attempt == 49:
                raise RuntimeError('Local nginx did not become ready') from None
            time.sleep(.1)
    headers = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    }
    with urllib.request.urlopen(base + '/oauth/callback.html?code=' + marker, timeout=5) as response:
        body = response.read(16385)
        check(response.status == 200 and len(body) <= 16384, 'Built callback is served within the fixture document bound')
        for key, value in headers.items():
            check(response.headers.get(key) == value, key + ' matches callback policy')
        report['callbackHeaders'] = headers
    check(body == (ROOT / 'apps/web/dist/oauth/callback.html').read_bytes(), 'Served callback bytes match the built artifact')
    check(marker.encode() not in body, 'Callback response does not reflect query data')
    check(b'no-referrer' in body and b'oauthCallback-' in body, 'Built callback retains its referrer policy and dedicated entry')
    logs = command('docker', 'logs', name)
    check(marker not in logs and '/oauth/callback.html' not in logs, 'Callback requests are absent from nginx logs')
    report['sourceSha256'] = {p: digest(ROOT / p) for p in [
        'apps/web/vite.config.ts', 'apps/web/oauth/callback.html', 'apps/web/src/oauth-callback.ts',
        'deploy/docker/nginx.conf', 'tests/hosts/browser-oauth-deployment.py']}
    report['builtCallbackSha256'] = digest(ROOT / 'apps/web/dist/oauth/callback.html')
    report['status'] = 'passed'
except Exception as error:
    # Do not retain command output or request URLs on failure.
    report['error'] = type(error).__name__
finally:
    cleanup = subprocess.run(['docker', 'rm', '--force', name], capture_output=True, text=True, timeout=45)
    report['containerRemoved'] = cleanup.returncode == 0
    if not report['containerRemoved']:
        report['status'] = 'failed'
    report['completedAt'] = datetime.now(timezone.utc).isoformat()
    output = ROOT / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'status': report['status'], 'checks': len(report['checks']), 'report': args.output}))
raise SystemExit(0 if report['status'] == 'passed' else 1)
