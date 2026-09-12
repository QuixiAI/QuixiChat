import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createRelay } from '../src/server.mjs';
import { configuration, headers, listen } from './fixture.mjs';
const directory = process.env.QUIXI_SYNTHETIC_TLS_DIR;
let received = 0;
const fixture = https.createServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, async (req, res) => {
  received++; assert.equal(req.headers['x-api-key'], 'synthetic-provider-secret');
  for await (const _chunk of req) { /* synthetic body only */ }
  res.end('TLS fixture');
});
await listen(fixture);
try {
  for (const hostname of ['synthetic.fixture.invalid', 'wrong.fixture.invalid']) {
    let resolutions = 0;
    const relay = createRelay(configuration(`https://${hostname}:${fixture.address().port}`), { networkPolicy: {
      validateOrigin(url) { assert.equal(url.protocol, 'https:'); assert.ok(url.hostname.endsWith('.fixture.invalid')); },
      async resolve() { resolutions++; return { address: '127.0.0.1', family: 4 }; },
    } });
    const origin = await listen(relay.server);
    try {
      const r = await fetch(`${origin}/v1/provider-http`, { method: 'POST', headers: headers(), body: 'synthetic' });
      const expectedSuccess = process.env.QUIXI_SYNTHETIC_TLS_TRUST === 'yes' && hostname === 'synthetic.fixture.invalid';
      assert.equal(r.status, expectedSuccess ? 200 : 502); await r.text(); assert.equal(resolutions, 1);
    } finally { await relay.close(); }
  }
  assert.equal(received, process.env.QUIXI_SYNTHETIC_TLS_TRUST === 'yes' ? 1 : 0);
} finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
