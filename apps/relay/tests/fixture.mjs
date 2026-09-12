import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createRelay } from '../src/server.mjs';
export const token = randomBytes(32).toString('base64url');
export const origin = 'http://127.0.0.1:4197';
export const localPolicy = {
  validateOrigin(url) { if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Fixture requires exact loopback'); },
  async resolve(url) { this.validateOrigin(url); return { address: '127.0.0.1', family: 4 }; },
};
export const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
export function configuration(upstreamOrigin, limits = {}) {
  return {
    allowedOrigins: [origin],
    destinations: [{ id: 'fixture', origin: upstreamOrigin, credential: { header: 'x-api-key', prefix: '', required: true }, routes: ['/echo', '/stream', '/idle', '/redirect', '/error', '/large'].map(path => ({ path, methods: ['POST', 'GET'], headers: ['content-type'], ...(path === '/echo' ? { query: ['after_id', 'limit'] } : {}) })) }],
    principals: [{ id: 'synthetic', tokenSha256: createHash('sha256').update(token).digest('hex'), destinations: ['fixture'], maxConcurrent: 4, requestsPerMinute: 1000, burst: 100 }],
    limits: { requestsPerMinute: 1000, burst: 100, totalMs: 3000, idleMs: 1000, ...limits },
  };
}
export function headers(path = '/echo', extra = {}) {
  return { origin, authorization: `Bearer ${token}`, 'x-quixi-destination': 'fixture', 'x-quixi-method': 'POST', 'x-quixi-path': path, 'x-quixi-provider-authorization': 'synthetic-provider-secret', 'content-type': 'application/json', ...extra };
}
export async function fixture(limits = {}, configure = x => x) {
  const received = [], logs = [];
  let disconnected = 0;
  const upstream = http.createServer(async (req, res) => {
    received.push({ headers: req.headers, path: req.url, method: req.method });
    res.on('close', () => { if (!res.writableFinished) disconnected++; });
    if (req.url === '/idle') return;
    if (req.url === '/redirect') { res.writeHead(307, { location: '/echo' }); res.end(); return; }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-id', 'set-cookie': 'must-not-forward=yes' });
      res.write('data: first\n\n');
      const timer = setInterval(() => res.write('data: later\n\n'), 40);
      res.once('close', () => clearInterval(timer)); return;
    }
    if (req.url === '/large') { res.end(Buffer.alloc(65536)); return; }
    const chunks = []; try { for await (const chunk of req) chunks.push(chunk); } catch { res.destroy(); return; }
    res.writeHead(req.url === '/error' ? 429 : 200, { 'content-type': 'application/json', 'retry-after': '3', 'x-request-id': 'synthetic-id' });
    res.end(Buffer.concat(chunks));
  });
  const upstreamOrigin = await listen(upstream);
  const config = configure(configuration(upstreamOrigin, limits));
  const relay = createRelay(config, { networkPolicy: localPolicy, logger: record => logs.push(record) });
  const relayOrigin = await listen(relay.server);
  return { relay, relayOrigin, upstreamOrigin, config, received, logs, disconnected: () => disconnected,
    async close() { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); },
    request(path = '/echo', options = {}) { return fetch(`${relayOrigin}/v1/provider-http`, { method: 'POST', headers: headers(path), body: '{"synthetic":true}', ...options }); },
  };
}
