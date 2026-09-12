import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, headers, origin, configuration, localPolicy, token } from './fixture.mjs';
import { createRelay } from '../src/server.mjs';
import { parseConfig } from '../src/config.mjs';
import { isPublicAddress } from '../src/policy.mjs';

test('public address policy rejects special ranges and mapped IPv6', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.1.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', '2001:db8::1', '2002:808:808::1', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
});
test('production configuration rejects private transport and unknown local-policy flags', () => {
  assert.throws(() => createRelay(configuration('http://127.0.0.1:1234')));
  assert.throws(() => parseConfig({ ...configuration('https://example.com'), allowLocal: true }));
  const config = configuration('https://example.com'); config.destinations[0].routes[0].headers.push('authorization'); assert.throws(() => parseConfig(config));
});
test('raw body, upstream status, registered credential scheme and redacted diagnostics', async t => {
  const f = await fixture(); t.after(() => f.close());
  const response = await f.request('/error'); assert.equal(response.status, 429); assert.equal(await response.text(), '{"synthetic":true}');
  assert.equal(response.headers.get('retry-after'), '3');
  const upstream = f.received[0]; assert.equal(upstream.headers['x-api-key'], 'synthetic-provider-secret');
  for (const name of ['authorization', 'cookie', 'x-quixi-destination', 'x-quixi-provider-authorization', 'origin']) assert.equal(upstream.headers[name], undefined);
  const log = JSON.stringify(f.logs); for (const value of [token, 'synthetic-provider-secret', '{"synthetic":true}']) assert.equal(log.includes(value), false);
});
test('explicit origins and exact preflight allowlist', async t => {
  const f = await fixture(); t.after(() => f.close());
  const response = await fetch(`${f.relayOrigin}/v1/provider-http`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,x-quixi-destination,x-quixi-path,x-quixi-method,x-quixi-provider-authorization,content-type' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  for (const bad of [{ origin: 'https://unregistered.example' }, { 'access-control-request-headers': 'cookie' }]) {
    const r = await fetch(`${f.relayOrigin}/v1/provider-http`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', ...bad } }); assert.equal(r.status, 403);
  }
  assert.equal(f.received.length, 0);
});
test('auth, destination, route, query and credential-header restrictions stop dispatch', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const override of [
    { authorization: 'Bearer short' }, { authorization: `Bearer ${'a'.repeat(43)}` }, { origin: 'https://unregistered.example' },
    { 'x-quixi-destination': 'https://example.com' }, { 'x-quixi-path': '/echo?unexpected=1' }, { 'x-quixi-method': 'PATCH' },
    { 'x-api-key': 'override' }, { cookie: 'private=value' }, { 'x-quixi-url': 'https://example.com' },
    { 'x-quixi-query': 'unexpected=1' }, { 'x-quixi-query': `after_id=${'a'.repeat(257)}` }, { 'x-quixi-query': '' },
  ]) { const r = await f.request('/echo', { headers: headers('/echo', override) }); assert.ok(r.status >= 400); await r.text(); }
  const denied = await f.request('/error', { headers: headers('/error', { 'x-quixi-query': 'after_id=1' }) }); assert.equal(denied.status, 403); await denied.text();
  const r = await fetch(`${f.relayOrigin}/v1/provider-http?path=/echo`, { method: 'POST', headers: headers() }); assert.equal(r.status, 404);
  assert.equal(f.received.length, 0);
});
test('registered query names are re-encoded onto the upstream path', async t => {
  const f = await fixture(); t.after(() => f.close());
  const response = await f.request('/echo', { headers: headers('/echo', { 'x-quixi-query': 'after_id=model+a%26b&limit=1000' }) });
  assert.equal(response.status, 200); await response.text();
  assert.equal(f.received[0].path, '/echo?after_id=model+a%26b&limit=1000');
  assert.equal(f.received[0].headers['x-quixi-query'], undefined);
});
test('redirect denied without follow-up', async t => {
  const f = await fixture(); t.after(() => f.close());
  const r = await f.request('/redirect'); assert.equal(r.status, 502); assert.equal((await r.json()).error.code, 'UPSTREAM_REDIRECT_DENIED'); assert.equal(f.received.length, 1);
});
test('upload and response caps, idle deadline release admission', async t => {
  const f = await fixture({ maxUploadBytes: 32, maxResponseBytes: 32, idleMs: 80 }); t.after(() => f.close());
  const upload = await f.request('/echo', { body: 'x'.repeat(33) }); assert.equal(upload.status, 413); await upload.text(); assert.equal(f.received.length, 0);
  const large = await f.request('/large'); assert.equal(large.status, 502); await large.text();
  const idle = await f.request('/idle'); assert.equal(idle.status, 504); assert.equal((await idle.json()).error.code, 'IDLE_TIMEOUT');
  await delay(20); assert.equal(f.relay.stats().active, 0); assert.ok(f.disconnected() >= 1);
});
test('stream delivered incrementally and consumer cancellation disconnects upstream', async t => {
  const f = await fixture(); t.after(() => f.close());
  const cancel = new AbortController(); const r = await f.request('/stream', { signal: cancel.signal });
  assert.equal(r.headers.get('set-cookie'), null); const reader = r.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/); cancel.abort();
  await delay(80); assert.equal(f.relay.stats().active, 0); assert.ok(f.disconnected() >= 1);
});
test('per-principal and global admission and rate limits', async t => {
  const f = await fixture({ maxConcurrent: 1 }, c => { c.principals[0].maxConcurrent = 1; return c; }); t.after(() => f.close());
  const cancel = new AbortController(); const first = await f.request('/stream', { signal: cancel.signal }); assert.equal(first.status, 200);
  const busy = await f.request(); assert.equal(busy.status, 429); assert.equal((await busy.json()).error.code, 'CONCURRENCY_LIMIT'); cancel.abort();
  for (const global of [true, false]) {
    const r = await fixture(global ? { burst: 1, requestsPerMinute: 1 } : {}, c => { if (!global) { c.principals[0].burst = 1; c.principals[0].requestsPerMinute = 1; } return c; }); t.after(() => r.close());
    await (await r.request()).text(); const limited = await r.request(); assert.equal(limited.status, 429); assert.equal((await limited.json()).error.code, global ? 'GLOBAL_RATE_LIMIT' : 'PRINCIPAL_RATE_LIMIT');
  }
});
test('total deadline includes an active streaming consumer', async t => {
  const f = await fixture({ totalMs: 100, idleMs: 1000 }); t.after(() => f.close());
  const r = await f.request('/stream'); await assert.rejects(r.text()); await delay(20); assert.equal(f.relay.stats().active, 0); assert.equal(f.logs.at(-1).code, 'TOTAL_TIMEOUT');
});

test('production policy rejects actual localhost DNS before connection', async t => {
  const { listen } = await import('./fixture.mjs');
  const relay = createRelay(configuration('https://localhost'));
  const endpoint = await listen(relay.server); t.after(() => relay.close());
  const r = await fetch(`${endpoint}/v1/provider-http`, { method: 'POST', headers: headers(), body: '{}' });
  assert.equal(r.status, 502); assert.equal((await r.json()).error.code, 'UPSTREAM_UNAVAILABLE');
});
test('fixture hostname uses pinned DNS once and ignores environment proxies', async t => {
  const { listen } = await import('./fixture.mjs');
  const f = await fixture(); t.after(() => f.close());
  const config = configuration(f.upstreamOrigin.replace('127.0.0.1', 'synthetic.fixture.invalid'));
  let resolutions = 0;
  const relay = createRelay(config, { networkPolicy: {
    validateOrigin(url) { assert.equal(url.hostname, 'synthetic.fixture.invalid'); },
    async resolve() { resolutions++; return { address: '127.0.0.1', family: 4 }; },
  } });
  t.after(() => relay.close()); const endpoint = await listen(relay.server);
  const prior = process.env.HTTP_PROXY; process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  t.after(() => { if (prior === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = prior; });
  const r = await fetch(`${endpoint}/v1/provider-http`, { method: 'POST', headers: headers(), body: 'pinned' });
  assert.equal(r.status, 200); assert.equal(await r.text(), 'pinned'); assert.equal(resolutions, 1); assert.equal(f.received.length, 1);
});
test('chunked upload limit aborts dispatch and releases operation', async t => {
  const { Readable } = await import('node:stream');
  const f = await fixture({ maxUploadBytes: 32 }); t.after(() => f.close());
  const body = Readable.from((async function* () { yield Buffer.alloc(16); await delay(10); yield Buffer.alloc(32); })());
  // An over-limit in-flight body may terminate its connection after response.
  try { const r = await f.request('/echo', { body, duplex: 'half' }); assert.equal(r.status, 413); } catch (error) { assert.equal(error.name, 'TypeError'); }
  await delay(30); assert.equal(f.relay.stats().active, 0); assert.equal(f.logs.at(-1).code, 'UPLOAD_LIMIT');
});

test('stalled DNS remains admission-bounded after request deadline', async t => {
  const { listen } = await import('./fixture.mjs'); let calls = 0;
  const relay = createRelay(configuration('https://synthetic.fixture.invalid', { maxConcurrent: 1, totalMs: 40, idleMs: 100 }), { networkPolicy: {
    validateOrigin() {}, resolve() { calls++; return new Promise(() => {}); },
  } });
  t.after(() => relay.close()); const endpoint = await listen(relay.server);
  const first = await fetch(`${endpoint}/v1/provider-http`, { method: 'POST', headers: headers() }); assert.equal(first.status, 504); await first.text();
  const second = await fetch(`${endpoint}/v1/provider-http`, { method: 'POST', headers: headers() }); assert.equal(second.status, 503); assert.equal((await second.json()).error.code, 'DNS_ADMISSION_LIMIT'); assert.equal(calls, 1);
});

test('slow downstream backpressure stops an unbounded synthetic producer', async t => {
  const http = await import('node:http'); const { once } = await import('node:events'); const { listen } = await import('./fixture.mjs');
  let produced = 0, producerClosed = false;
  const upstream = http.createServer(async (_req, res) => {
    res.once('close', () => { producerClosed = true; });
    try { for (;;) { produced += 65536; if (!res.write(Buffer.alloc(65536))) await once(res, 'drain'); } } catch { /* cancelled fixture */ }
  });
  const upstreamOrigin = await listen(upstream);
  const relay = createRelay(configuration(upstreamOrigin, { idleMs: 1000 }), { networkPolicy: localPolicy });
  const endpoint = await listen(relay.server);
  t.after(async () => { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const request = http.request(`${endpoint}/v1/provider-http`, { method: 'POST', headers: headers() }); request.on('error', () => {});
  const pending = once(request, 'response'); request.end(); const [response] = await pending; response.pause();
  await delay(100); assert.equal(relay.stats().active, 1); assert.ok(produced < 64 * 1024 * 1024, `producer sent ${produced} bytes without consumption`);
  response.destroy(); request.destroy(); await delay(50); assert.equal(relay.stats().active, 0); assert.equal(producerClosed, true);
});
