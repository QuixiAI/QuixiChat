#!/usr/bin/env python3
"""Installed macOS OAuth/callback qualification with synthetic TLS endpoints."""
import argparse
import base64
import ctypes
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import plistlib
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlencode, urlsplit
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BINARY = ROOT / 'target/debug/quixi-oauth-proof'
LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
PHASES = ['cold', 'success', 'bad-state', 'bad-issuer', 'bad-path', 'duplicate-query', 'denied', 'expired', 'duplicate-callback', 'cancel', 'dispose', 'reload', 'cancel-token', 'commit-cancel', 'overload', 'oversize-token', 'invalid-token', 'malformed-token', 'redirect-token', 'auxiliary-tokens']
SUCCESS_PHASES = {'success', 'bad-state', 'bad-issuer', 'bad-path', 'duplicate-query', 'duplicate-callback', 'commit-cancel', 'auxiliary-tokens'}
TOKEN_PHASES = SUCCESS_PHASES | {'cancel-token', 'oversize-token', 'invalid-token', 'malformed-token', 'redirect-token'}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def private_json(path, value):
    temporary = path.with_suffix('.pending')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
    temporary.replace(path)


def read_json(path):
    try:
        if path.stat().st_size > 262144:
            raise RuntimeError('Proof control/report exceeded its bound')
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def default_handler(scheme):
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    services = ctypes.CDLL('/System/Library/Frameworks/CoreServices.framework/CoreServices')
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFRelease.argtypes = [ctypes.c_void_p]
    services.LSCopyDefaultHandlerForURLScheme.argtypes = [ctypes.c_void_p]
    services.LSCopyDefaultHandlerForURLScheme.restype = ctypes.c_void_p
    value = cf.CFStringCreateWithCString(None, scheme.encode(), 0x08000100)
    result = services.LSCopyDefaultHandlerForURLScheme(value)
    cf.CFRelease(value)
    if not result:
        return None
    try:
        buffer = ctypes.create_string_buffer(4096)
        if not cf.CFStringGetCString(result, buffer, 4096, 0x08000100):
            raise RuntimeError('LaunchServices handler exceeded its bound')
        return buffer.value.decode()
    finally:
        cf.CFRelease(result)


class Endpoints:
    def __init__(self, directory, control, scheme, secret_values):
        self.phase = 'setup'
        self.control, self.scheme, self.secret_values = control, scheme, secret_values
        self.tokens, self.provider, self.handshakes = [], [], []
        self.codes = {}
        self.release = threading.Event()
        self.lock = threading.Lock()
        self.token = ''
        self.ca = directory / 'ca.pem'
        key, certificate, ca_key, csr, extensions = [directory / name for name in ['key.pem', 'certificate.pem', 'ca-key.pem', 'server.csr', 'server.ext']]
        extensions.write_text('subjectAltName=DNS:oauth.synthetic.invalid\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
        for argv in [
            ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ca_key), '-out', str(self.ca), '-days', '1', '-subj', '/CN=Quixi ephemeral OAuth proof CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'],
            ['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(csr), '-subj', '/CN=oauth.synthetic.invalid'],
            ['openssl', 'x509', '-req', '-in', str(csr), '-CA', str(self.ca), '-CAkey', str(ca_key), '-CAcreateserial', '-out', str(certificate), '-days', '1', '-extfile', str(extensions)],
        ]:
            result = subprocess.run(argv, capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError('Ephemeral OAuth TLS certificate generation failed')
        self.certificate_sha256 = digest(certificate)
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                pass

            def reply(self, status, body, headers=None):
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Connection', 'close')
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

            def do_POST(self):
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 16384 or self.path != '/token':
                    self.reply(400, b'{}')
                    return
                values = parse_qs(self.rfile.read(length).decode(), keep_blank_values=True, strict_parsing=True)
                one = lambda name: values.get(name, [''])[0] if len(values.get(name, [])) == 1 else ''
                code, verifier = one('code'), one('code_verifier')
                owner.secret_values.append(('verifier', verifier))
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
                expected = owner.codes.pop(code, None)
                entry = {'phase': owner.phase, 'path': self.path, 'method': self.command, 'bodyBytes': length, 'headerNames': sorted(self.headers), 'sni': getattr(self.connection, 'proof_sni', None), 'host': self.headers.get('Host'), 'codeKnown': expected is not None, 'pkceMatches': expected is not None and secrets.compare_digest(challenge, expected), 'redirectMatches': one('redirect_uri') == owner.scheme + '://oauth/callback', 'clientMatches': one('client_id') == 'quixi-native-oauth-proof', 'grantMatches': one('grant_type') == 'authorization_code', 'responseDelivered': False}
                with owner.lock:
                    owner.tokens.append(entry)
                    private_json(owner.control / 'token-observed.json', {'tokenRequests': len([item for item in owner.tokens if item['phase'] == owner.phase])})
                valid = all(entry[name] for name in ['codeKnown', 'pkceMatches', 'redirectMatches', 'clientMatches', 'grantMatches']) and entry['sni'] == 'oauth.synthetic.invalid' and entry['host'] == 'oauth.synthetic.invalid'
                if not valid:
                    self.reply(400, b'{}')
                    return
                if owner.phase == 'cancel-token':
                    owner.release.wait(15)
                    entry['releasedAfterCancellation'] = (read_json(owner.control / 'stage.json') or {}).get('stage') == 'token-cancelled'
                payload = {'access_token': owner.token, 'token_type': 'Bearer', 'expires_in': 3600}
                if owner.phase == 'oversize-token':
                    payload['access_token'] = 'A' * 131072
                if owner.phase == 'invalid-token':
                    payload['token_type'] = 'NotBearer'
                if owner.phase == 'auxiliary-tokens':
                    for name in ['refresh_token', 'id_token']:
                        value = 'synthetic-' + name + '-' + str(uuid.uuid4())
                        owner.secret_values.append((name, value))
                        payload[name] = value
                try:
                    if owner.phase == 'redirect-token':
                        self.reply(302, b'{}', {'Location': 'https://oauth.synthetic.invalid/forbidden-redirect'})
                    elif owner.phase == 'malformed-token':
                        self.reply(200, b'{')
                    else:
                        self.reply(200, json.dumps(payload).encode())
                    entry['responseDelivered'] = True
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass  # A cancelled bounded native exchange closes its socket.

            def do_GET(self):
                allowed = self.path == '/v1/models' and self.headers.get('Authorization') == 'Bearer ' + owner.token
                entry = {'phase': owner.phase, 'method': self.command, 'path': self.path, 'credentialMatchesIssuedAccessToken': allowed, 'authorizationPresent': bool(self.headers.get('Authorization')), 'headerNames': sorted(self.headers)}
                owner.provider.append(entry)
                self.reply(200 if allowed else 401, b'{"authorized":true}')

        self.tls = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.tls.daemon_threads = self.http.daemon_threads = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        def sni(connection, name, _context):
            setattr(connection, 'proof_sni', name)
            owner.handshakes.append({'phase': owner.phase, 'sni': name})
        context.set_servername_callback(sni)
        self.tls.socket = context.wrap_socket(self.tls.socket, server_side=True)
        self.tls_port, self.http_port = self.tls.server_address[1], self.http.server_address[1]
        for server in [self.tls, self.http]:
            threading.Thread(target=server.serve_forever, daemon=True).start()

    def begin(self, phase):
        self.phase = phase
        self.release.clear()
        self.codes.clear()
        self.token = 'synthetic-access-' + str(uuid.uuid4())
        self.secret_values.append(('access_token', self.token))

    def callback(self, authorization, variant=None):
        parsed = urlsplit(authorization)
        values = parse_qs(parsed.query, strict_parsing=True)
        required = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']
        if parsed.scheme != 'https' or parsed.hostname != 'oauth.synthetic.invalid' or parsed.path != '/authorize' or set(values) != set(required) or any(len(values[key]) != 1 for key in required):
            raise RuntimeError('Native authorization request escaped the fixed fixture configuration')
        if values['response_type'] != ['code'] or values['code_challenge_method'] != ['S256'] or values['client_id'] != ['quixi-native-oauth-proof'] or values['redirect_uri'] != [self.scheme + '://oauth/callback'] or values['scope'] != ['profile']:
            raise RuntimeError('Native authorization request lacks exact code/PKCE/redirect/scope binding')
        state = values['state'][0]
        self.secret_values.append(('state', state))
        code = 'synthetic-code-' + str(uuid.uuid4())
        self.secret_values.append(('code', code))
        self.codes[code] = values['code_challenge'][0]
        query = [('state', 'wrong-synthetic-state' if variant == 'bad-state' else state), ('iss', 'https://wrong.synthetic.invalid' if variant == 'bad-issuer' else 'https://oauth.synthetic.invalid')]
        query.append(('error', 'access_denied') if variant == 'denied' else ('code', code))
        if variant == 'duplicate-query':
            query.append(('state', state))
        path = '/wrong-path' if variant == 'bad-path' else '/callback'
        return self.scheme + '://oauth' + path + '?' + urlencode(query)

    def close(self):
        self.release.set()
        for server in [self.tls, self.http]:
            server.shutdown()
            server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=HERE / 'evidence/native-oauth-macos.json')
    args = parser.parse_args()
    if sys.platform != 'darwin' or int(platform.mac_ver()[0].split('.')[0]) < 14:
        raise RuntimeError('Installed OAuth proof requires macOS14+ for mandatory isolated WKWebView storage')
    profile = str(uuid.uuid4())
    scheme = 'ai.quixi.chat.oauth-proof.' + profile
    secret_values = []
    report = {'status': 'running', 'startedAt': now(), 'profile': profile, 'scheme': scheme, 'platform': platform.platform(), 'macos': platform.mac_ver()[0], 'systemWebKitVersion': plistlib.loads(Path('/System/Library/Frameworks/WebKit.framework/Resources/Info.plist').read_bytes())['CFBundleVersion'], 'scope': 'Actual installed unique macOS app and LaunchServices cold/warm callback delivery into production native OAuth, TLS token exchange, and Keychain-backed native HTTP. The proof-only opener exports a synthetic authorization URL (state and PKCE challenge) to private temporary control files; it does not launch or qualify an external authorization browser. No live provider account, default browser/profile, production app registration, refresh/ID-token login, or expiry enforcement claim.', 'commands': [], 'phases': [], 'sourceSha256': {}, 'cleanup': {}}
    temporary = Path(tempfile.mkdtemp(prefix='quixi-oauth-parent-'))
    control = temporary / ('quixi-oauth-proof-' + profile)
    control.mkdir(mode=0o700)
    applications = Path.home() / 'Applications'
    bundle = applications / ('Quixi OAuth Proof ' + profile + '.app')
    webkit_directory = Path.home() / 'Library/WebKit' / scheme
    fixture = None
    installed = False
    bundle_created = False

    def safe(value):
        if isinstance(value, str):
            for kind, secret in secret_values:
                if len(secret) >= 8 and secret in value:
                    value = value.replace(secret, '[redacted synthetic ' + kind + ']')
                    report['sensitiveOutputDetected'] = True
            return value
        if isinstance(value, list):
            return [safe(item) for item in value]
        if isinstance(value, dict):
            return {key: safe(item) for key, item in list(value.items())}
        return value

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(safe(report), indent=2) + '\n')

    def command(argv, timeout=600, env=None):
        started = now()
        result = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)
        report['commands'].append({'argv': argv, 'startedAt': started, 'completedAt': now(), 'exitCode': result.returncode, 'stdout': safe(result.stdout[-8192:]), 'stderr': safe(result.stderr[-16384:])})
        save()
        if result.returncode:
            raise RuntimeError('Proof build/install command failed: ' + argv[0])
        return result

    def run_phase(phase):
        for path in control.iterdir():
            if path.is_file():
                path.unlink()
        private_json(control / 'phase.json', {'phase': phase})
        fixture.begin(phase)
        entry = {'phase': phase, 'startedAt': now(), 'callbacks': []}
        executable = bundle / 'Contents/MacOS/quixi-oauth-proof'
        env = {key: value for key, value in os.environ.items() if key.lower() not in {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}}
        if phase == 'cold':
            cold_url = scheme + '://oauth/callback?' + urlencode({'state': 'synthetic-no-pending-state', 'iss': 'https://oauth.synthetic.invalid', 'code': 'synthetic-no-pending-code'})
            process = subprocess.Popen(['/usr/bin/open', '-W', cold_url], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            entry['launchMode'] = 'LaunchServices URL cold launch; open exit status is launcher status, native exit marker is separate'
            entry['callbacks'].append({'variant': 'cold-no-pending', 'delivery': '/usr/bin/open', 'queryNames': ['state', 'iss', 'code']})
        else:
            process = subprocess.Popen([str(executable)], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            entry['launchMode'] = 'direct installed executable with verified child exit code; callbacks delivered by LaunchServices'
        authorization = None
        initial_sent = False
        followup_sent = False
        auth_seen_at = None
        native_pid = None
        deadline = time.monotonic() + 55

        def deliver(url, variant):
            result = subprocess.run(['/usr/bin/open', url], capture_output=True, text=True, timeout=10)
            entry['callbacks'].append({'variant': variant, 'delivery': '/usr/bin/open', 'exitCode': result.returncode, 'queryNames': [key for key, _value in __import__('urllib.parse', fromlist=['parse_qsl']).parse_qsl(urlsplit(url).query)], 'stderr': safe(result.stderr[-2048:])})
            if result.returncode:
                raise RuntimeError('LaunchServices callback delivery failed')

        try:
            while time.monotonic() < deadline:
                ready = read_json(control / 'ready.json')
                if ready:
                    native_pid = ready['pid']
                    if ready['profile'] != profile or ready['phase'] != phase or (phase != 'cold' and native_pid != process.pid):
                        raise RuntimeError('Callback opened a different process or isolated profile')
                result = read_json(control / 'result.json')
                if result:
                    entry['native'] = result
                    break
                captured = read_json(control / 'authorization-1.json')
                if captured and authorization is None:
                    authorization = captured['url']
                    auth_seen_at = time.monotonic()
                observed_stage = (read_json(control / 'stage.json') or {}).get('stage')
                if authorization and not initial_sent and phase not in {'overload', 'cleanup'}:
                    permitted = (phase not in {'cancel', 'dispose', 'reload', 'expired'} or phase in {'cancel', 'dispose'} and observed_stage == 'request-cancelled' or phase == 'reload' and observed_stage == 'renderer-reloaded' or phase == 'expired' and time.monotonic() - auth_seen_at > .7)
                    if permitted:
                        url = fixture.callback(authorization, phase)
                        deliver(url, phase)
                        initial_sent = True
                        if phase == 'duplicate-callback':
                            deliver(url, 'duplicate-of-consumed-callback')
                if authorization and initial_sent and not followup_sent and phase in {'bad-state', 'bad-issuer', 'bad-path', 'duplicate-query'} and observed_stage == 'bad-callback-rejected':
                    deliver(fixture.callback(authorization), 'legitimate-pending-flow-after-rejection')
                    followup_sent = True
                if observed_stage == 'token-cancelled':
                    fixture.release.set()
                if observed_stage == 'commit-cancelled':
                    private_json(control / 'commit-release.json', {'release': True})
                if process.poll() is not None and not (control / 'result.json').exists():
                    raise RuntimeError('Native/launcher process exited before a bounded proof result')
                time.sleep(.02)
            else:
                raise RuntimeError('Installed OAuth phase exceeded its bounded deadline')
            stdout, stderr = process.communicate(timeout=10)
            entry.update({'processExitCode': process.returncode, 'stdout': safe(stdout[-2048:]), 'stderr': safe(stderr[-8192:]), 'nativeExit': read_json(control / 'exit.json')})
            native = entry['native']
            if native['profile'] != profile or native['phase'] != phase or native['configuredCsp'] != report['configuredCsp'] or native['keychainService'] != scheme:
                raise RuntimeError('Native phase changed its profile, CSP or Keychain isolation')
            if not entry['nativeExit'] or entry['nativeExit']['code'] != 0 or not entry['nativeExit']['runReturned'] or entry['nativeExit']['pid'] != native['pid']:
                raise RuntimeError('Native event loop did not report a successful actual return')
            if process.returncode != 0 or not native['webview'].get('success'):
                raise RuntimeError('Installed native OAuth phase assertions failed')
            tokens = [value for value in fixture.tokens if value['phase'] == phase]
            provider = [value for value in fixture.provider if value['phase'] == phase]
            if len(tokens) != (1 if phase in TOKEN_PHASES else 0) or len(provider) != (1 if phase in SUCCESS_PHASES else 0):
                raise RuntimeError('Actual token/provider HTTP counts differ from the scoped scenario')
            if any(not all(value[field] for field in ['codeKnown', 'pkceMatches', 'redirectMatches', 'clientMatches', 'grantMatches']) or value['sni'] != 'oauth.synthetic.invalid' or value['host'] != 'oauth.synthetic.invalid' for value in tokens) or any(not value['credentialMatchesIssuedAccessToken'] for value in provider):
                raise RuntimeError('Actual TLS PKCE or opaque credential use did not match the fixture')
            if phase == 'cancel-token' and tokens[0].get('releasedAfterCancellation') is not True:
                raise RuntimeError('Held token exchange was not released after explicit native cancellation')
            entry['success'] = True
        except Exception as error:
            entry.update({'success': False, 'error': str(error)})
        finally:
            fixture.release.set()
            private_json(control / 'commit-release.json', {'release': True})
            try:
                if process.poll() is None:
                    process.kill()
                # An OS callback can launch a different installed-app process.
                # Check its exact executable, including on a warm PID mismatch,
                # before killing or waiting; never kill a reused unrelated PID.
                if native_pid:
                    for attempt in range(30):
                        inspected = subprocess.run(['/bin/ps', '-p', str(native_pid), '-o', 'comm='], capture_output=True, text=True, timeout=3)
                        if inspected.stdout.strip() != str(executable):
                            break
                        if attempt == 0:
                            try:
                                os.kill(native_pid, 9)
                            except ProcessLookupError:
                                break
                        time.sleep(.05)
                    else:
                        raise RuntimeError('The exact isolated native process did not terminate')
                stdout, stderr = process.communicate(timeout=5)
                entry.update({'processExitCode': process.returncode, 'stdout': safe(stdout[-2048:]), 'stderr': safe(stderr[-8192:]), 'ownedProcessesTerminated': True})
            except Exception as error:
                entry.update({'success': False, 'ownedProcessesTerminated': False, 'processCleanupError': str(error)})
            entry['tokenRequests'] = [value.copy() for value in fixture.tokens if value['phase'] == phase]
            entry['providerRequests'] = [value.copy() for value in fixture.provider if value['phase'] == phase]
            entry['completedAt'] = now()
            report['phases'].append(entry)
            save()
            print('native OAuth ' + phase + ': ' + ('passed' if entry.get('success') else 'failed'), flush=True)
        return entry.get('success') is True

    try:
        if default_handler(scheme) is not None:
            raise RuntimeError('Refusing to take over an existing callback scheme')
        if webkit_directory.exists():
            raise RuntimeError('Refusing to reuse any existing proof application data directory')
        report['cleanup']['webkitDirectoryAbsentBeforeInstallation'] = True
        sources = ['Cargo.lock', 'package.json', 'package-lock.json', '.github/workflows/check.yml', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/src-tauri/Info.plist', 'apps/desktop/src-tauri/capabilities/default.json', 'apps/desktop/src/host/index.ts', *[str(path.relative_to(ROOT)) for folder in ['packages/core/src/contracts', 'packages/core/src/model'] for path in sorted((ROOT / folder).rglob('*.ts'))], *[str(path.relative_to(ROOT)) for path in sorted((ROOT / 'apps/desktop/src-tauri/src').rglob('*.rs'))], *[str(path.relative_to(ROOT)) for path in sorted(HERE.iterdir()) if path.is_file() and path.suffix in {'.rs', '.ts', '.py', '.mjs', '.json', '.html'}]]
        for source in sources:
            report['sourceSha256'][source] = digest(ROOT / source)
        environment = {**os.environ, 'QUIXI_OAUTH_PROOF_PROFILE': profile}
        for argv in [['node_modules/.bin/tsc', '--noEmit', '-p', 'tests/hosts/oauth-proof/tsconfig.json'], ['node', 'tests/hosts/oauth-proof/build.mjs'], ['cargo', 'build', '--locked', '-p', 'quixi-desktop', '--bin', 'quixi-oauth-proof', '--features', 'oauth-proof']]:
            command(argv, env=environment)
        production = json.loads((ROOT / 'apps/desktop/src-tauri/tauri.conf.json').read_text())
        built = json.loads((HERE / 'build/tauri.conf.json').read_text())
        if production['app']['security']['csp'] != built['app']['security']['csp'] or built['identifier'] != scheme:
            raise RuntimeError('Built proof changed production CSP or isolated identifier')
        report['configuredCsp'] = production['app']['security']['csp']
        report['buildBinarySha256'] = digest(BINARY)
        report['bundledSha256'] = {str(path.relative_to(HERE / 'build/dist')): digest(path) for path in sorted((HERE / 'build/dist').rglob('*')) if path.is_file()}
        fixture = Endpoints(temporary, control, scheme, secret_values)
        report['fixture'] = {'tlsHostname': 'oauth.synthetic.invalid', 'tlsPort': fixture.tls_port, 'certificateSha256': fixture.certificate_sha256, 'providerOrigin': 'http://127.0.0.1:' + str(fixture.http_port), 'authorizationOpener': 'native-only private temporary URL capture', 'externalBrowserQualified': False}
        if bundle.exists():
            raise RuntimeError('Refusing to overwrite any existing installed application')
        (bundle / 'Contents/MacOS').mkdir(parents=True)
        bundle_created = True
        (bundle / 'Contents/Resources').mkdir()
        shutil.copy2(BINARY, bundle / 'Contents/MacOS/quixi-oauth-proof')
        plist = {'CFBundleName': 'Quixi OAuth Proof', 'CFBundleDisplayName': 'Quixi OAuth Proof', 'CFBundleIdentifier': scheme, 'CFBundleExecutable': 'quixi-oauth-proof', 'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '0.0.1', 'LSMinimumSystemVersion': '14.0', 'NSHighResolutionCapable': True, 'CFBundleURLTypes': [{'CFBundleURLName': scheme, 'CFBundleTypeRole': 'Viewer', 'CFBundleURLSchemes': [scheme]}]}
        (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
        private_json(bundle / 'Contents/Resources/proof-config.json', {'profile': profile, 'phase': 'cold', 'scheme': scheme, 'tlsPort': fixture.tls_port, 'tlsCa': str(fixture.ca), 'httpPort': fixture.http_port, 'controlDirectory': str(control)})
        command(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(bundle)], timeout=30)
        installed = True
        command([LSREGISTER, '-f', str(bundle)], timeout=30)
        for _ in range(100):
            if default_handler(scheme) == scheme:
                break
            time.sleep(.05)
        if default_handler(scheme) != scheme:
            raise RuntimeError('LaunchServices did not register the unique proof scheme')
        report['installedBundle'] = {'path': str(bundle), 'identifier': scheme, 'scheme': scheme, 'binarySha256': digest(bundle / 'Contents/MacOS/quixi-oauth-proof'), 'infoPlistSha256': digest(bundle / 'Contents/Info.plist'), 'defaultHandler': default_handler(scheme), 'productionSchemeInherited': 'ai.quixi.chat' in plist['CFBundleURLTypes'][0]['CFBundleURLSchemes']}
        try:
            for phase in PHASES:
                if not run_phase(phase):
                    break
        finally:
            run_phase('cleanup')
        if len(report['phases']) != len(PHASES) + 1 or not all(entry.get('success') for entry in report['phases']):
            raise RuntimeError('Not every required installed callback/OAuth phase passed')
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
    finally:
        cleanup_errors = []
        if fixture:
            try:
                fixture.close()
            except Exception as error:
                cleanup_errors.append('Synthetic endpoint close: ' + str(error))
        if installed:
            try:
                unregistered = subprocess.run([LSREGISTER, '-u', str(bundle)], capture_output=True, text=True, timeout=30)
                report['cleanup']['launchServicesUnregisterExitCode'] = unregistered.returncode
                if unregistered.returncode:
                    cleanup_errors.append('LaunchServices unregister returned nonzero')
            except Exception as error:
                cleanup_errors.append('LaunchServices unregister: ' + str(error))
        if bundle_created and bundle.exists() and bundle.name == 'Quixi OAuth Proof ' + profile + '.app':
            try:
                shutil.rmtree(bundle)
            except Exception as error:
                cleanup_errors.append('Owned bundle removal: ' + str(error))
        report['cleanup']['installedBundleRemoved'] = not bundle.exists()
        processes_terminated = all(entry.get('ownedProcessesTerminated') for entry in report['phases'])
        report['cleanup']['ownedProcessesTerminated'] = processes_terminated
        if not processes_terminated:
            cleanup_errors.append('Owned process termination could not be verified; isolated WebKit directory preserved')
        if bundle_created and processes_terminated and report['cleanup'].get('webkitDirectoryAbsentBeforeInstallation'):
            try:
                if webkit_directory.exists():
                    shutil.rmtree(webkit_directory)
                report['cleanup']['isolatedWebKitDirectory'] = str(webkit_directory)
                report['cleanup']['isolatedWebKitDirectoryRemoved'] = not webkit_directory.exists()
                report['cleanup']['dataStoreRemovalMethod'] = 'Remove only the unique proof application directory after its processes exit; no default profile inspection and no platform deletion API claim'
            except Exception as error:
                cleanup_errors.append('Isolated WebKit directory removal: ' + str(error))
        try:
            shutil.rmtree(temporary)
        except Exception as error:
            cleanup_errors.append('Private temporary files removal: ' + str(error))
        report['cleanup']['temporaryControlAndTlsFilesRemoved'] = not temporary.exists()
        report['cleanup']['errors'] = cleanup_errors
        if cleanup_errors:
            report['status'] = 'failed'
        report['changedSources'] = [source for source, value in report['sourceSha256'].items() if not (ROOT / source).is_file() or digest(ROOT / source) != value]
        if report['changedSources']:
            report['status'] = 'failed'
        report['completedAt'] = now()
        safe(report)
        if report.get('sensitiveOutputDetected'):
            report['status'] = 'failed'
        save()
        attempts = HERE / 'evidence/attempts'
        attempts.mkdir(parents=True, exist_ok=True)
        (attempts / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + profile + '.json')).write_bytes(args.output.read_bytes())
        if report['status'] == 'passed':
            retained = ROOT / 'docs/validation/results/native-oauth-macos.json'
            retained.parent.mkdir(parents=True, exist_ok=True)
            retained.write_bytes(args.output.read_bytes())
    print(json.dumps({'status': report['status'], 'phases': len(report['phases']), 'output': str(args.output), 'error': report.get('error')}, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
