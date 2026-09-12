import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
test('actual TLS validates fixture CA, original hostname and pinned connection; rejects untrusted CA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quixi-relay-tls-'));
  try {
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=synthetic.fixture.invalid', '-addext', 'subjectAltName=DNS:synthetic.fixture.invalid']);
    const file = fileURLToPath(new URL('./tls-fixture.mjs', import.meta.url));
    for (const trust of ['yes', 'no']) {
      const env = { ...process.env, QUIXI_SYNTHETIC_TLS_DIR: directory, QUIXI_SYNTHETIC_TLS_TRUST: trust, HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1' };
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      if (trust === 'yes') env.NODE_EXTRA_CA_CERTS = join(directory, 'cert.pem'); else delete env.NODE_EXTRA_CA_CERTS;
      await run(process.execPath, [file], { env, timeout: 15000 });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
