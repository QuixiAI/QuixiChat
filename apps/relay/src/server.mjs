import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { parseConfig } from './config.mjs';
import { publicNetworkPolicy } from './policy.mjs';

class Failure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
class Bucket {
  constructor(rate, burst) { this.rate = rate / 60000; this.burst = burst; this.tokens = burst; this.last = performance.now(); }
  take() { const now = performance.now(); this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.rate); this.last = now; if (this.tokens < 1) return false; this.tokens--; return true; }
}
const safeResponseHeaders = ['content-type', 'retry-after', 'x-request-id', 'request-id'];
const transportHeaders = new Set(['origin','host','connection','content-length','accept','accept-language','accept-encoding','cache-control','pragma','user-agent','referer','priority']);
const wireHeaders = ['authorization', 'x-quixi-destination', 'x-quixi-method', 'x-quixi-path', 'x-quixi-query', 'x-quixi-provider-authorization', 'x-quixi-configuration'];
const fail = (status, code) => { throw new Failure(status, code); };
const waitAbort = (promise, signal) => {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

// The executable always supplies publicNetworkPolicy. Dependency injection is
// for controlled fixtures only; JSON configuration cannot enable local egress.
export function createRelay(input, { networkPolicy = publicNetworkPolicy, logger = () => {} } = {}) {
  const config = parseConfig(input, networkPolicy);
  const globalRate = new Bucket(config.limits.requestsPerMinute, config.limits.burst);
  const states = new Map(config.principals.map(p => [p.id, { active: 0, rate: new Bucket(p.requestsPerMinute, p.burst) }]));
  const preflightHeaders = new Set([...wireHeaders, ...[...config.destinations.values()].flatMap(d => [...d.routes.values()].flatMap(r => [...r.headers]))]);
  let active = 0, resolving = 0;
  const pending = new Set();
  // Explicit private agents never opt into proxyEnv or shared global agents.
  const agents = {
    'https:': new https.Agent({ keepAlive: false, maxSockets: config.limits.maxConcurrent, maxCachedSessions: 0, rejectUnauthorized: true, proxyEnv: {} }),
    'http:': new http.Agent({ keepAlive: false, maxSockets: config.limits.maxConcurrent, proxyEnv: {} }),
  };
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: Math.min(10000, config.limits.totalMs), requestTimeout: config.limits.totalMs, keepAliveTimeout: 1000 }, (req, res) => {
    handle(req, res).catch(() => { res.destroy(); });
  });
  server.maxHeadersCount = 64;
  server.maxConnections = config.limits.maxConnections;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('close', () => { for (const controller of pending) controller.abort(new Failure(503, 'SHUTDOWN')); for (const agent of Object.values(agents)) agent.destroy(); });

  async function handle(req, res) {
    const started = performance.now(), requestId = randomUUID();
    let principal, destination, state, admitted = false, bytesIn = 0, bytesOut = 0, code;
    const controller = new AbortController(), { signal } = controller;
    let timer, idleTimer, upstream, response;
    const abort = reason => { if (!signal.aborted) controller.abort(reason); };
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abort(new Failure(504, 'IDLE_TIMEOUT')), config.limits.idleMs); idleTimer.unref(); };
    const destroyUpstream = () => { upstream?.destroy(signal.reason); response?.destroy(signal.reason); };
    signal.addEventListener('abort', destroyUpstream);
    const disconnected = () => { if (!res.writableFinished) abort(new Failure(499, 'CLIENT_DISCONNECTED')); };
    req.on('aborted', disconnected); res.on('close', disconnected);
    try {
      if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":true}'); return; }
      const metadata = req.url === '/v1/regional-configuration';
      if (req.url !== '/v1/provider-http' && !metadata) fail(404, 'ROUTE_NOT_FOUND');
      const seen = new Set();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (seen.has(name)) fail(400, 'DUPLICATE_HEADER');
        seen.add(name);
      }
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !config.origins.has(origin)) fail(403, 'ORIGIN_DENIED');
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-expose-headers', safeResponseHeaders.join(', '));
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method === 'OPTIONS') {
        const requested = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
        if (req.headers['access-control-request-method'] !== 'POST' || requested.length > 32 || requested.some(h => metadata ? !['authorization','x-quixi-destination'].includes(h) : !preflightHeaders.has(h))) fail(403, 'PREFLIGHT_DENIED');
        res.writeHead(204, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': requested.join(', '), 'access-control-max-age': '300', vary: 'Origin, Access-Control-Request-Headers' }); res.end(); return;
      }
      if (req.method !== 'POST') fail(405, 'METHOD_DENIED');
      if (!globalRate.take()) fail(429, 'GLOBAL_RATE_LIMIT');
      const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.headers.authorization ?? '');
      if (!match) fail(401, 'RELAY_AUTH_REQUIRED');
      const hash = createHash('sha256').update(match[1]).digest();
      for (const p of config.principals) if (timingSafeEqual(hash, p.hash)) principal = p;
      hash.fill(0);
      if (!principal) fail(401, 'RELAY_AUTH_REQUIRED');
      state = states.get(principal.id);
      if (!state.rate.take()) fail(429, 'PRINCIPAL_RATE_LIMIT');
      destination = config.destinations.get(req.headers['x-quixi-destination']);
      if (!destination || !principal.destinations.has(destination.id)) fail(403, 'DESTINATION_DENIED');
      if (metadata) {
        if (!destination.regionalDeclaration) fail(403, 'REGIONAL_CONFIGURATION_UNAVAILABLE');
        const allowed = new Set(['authorization','x-quixi-destination','origin','host','connection','content-length','accept','accept-language','accept-encoding','cache-control','pragma','priority','user-agent','referer','sec-fetch-mode','sec-fetch-site','sec-fetch-dest','sec-ch-ua','sec-ch-ua-platform','sec-ch-ua-mobile']);
        if (Object.keys(req.headers).some(name => !allowed.has(name))) fail(400, 'REGIONAL_METADATA_HEADER_DENIED');
        if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) fail(400, 'REGIONAL_METADATA_BODY_DENIED');
        if (String(req.headers.connection ?? '').toLowerCase().split(',').some(value => value.trim() && !['close','keep-alive'].includes(value.trim()))) fail(400, 'HOP_BY_HOP_HEADER_DENIED');
        if (active >= config.limits.maxConcurrent || state.active >= principal.maxConcurrent) fail(429, 'CONCURRENCY_LIMIT');
        active++; state.active++; admitted = true; pending.add(controller);
        timer = setTimeout(() => abort(new Failure(504, 'TOTAL_TIMEOUT')), config.limits.totalMs); timer.unref(); resetIdle();
        const empty = (async () => { for await (const chunk of req.iterator({ destroyOnReturn: false })) { bytesIn += chunk.length; if (chunk.length) fail(400, 'REGIONAL_METADATA_BODY_DENIED'); } })();
        await waitAbort(empty, signal); signal.throwIfAborted();
        const body = JSON.stringify(destination.regionalDeclaration);
        if (Buffer.byteLength(body) > 4096) fail(500, 'REGIONAL_CONFIGURATION_LIMIT');
        bytesOut = Buffer.byteLength(body); res.writeHead(200, { 'content-type': 'application/json', 'content-length': bytesOut }); res.end(body); return;
      }
      const configurationId = req.headers['x-quixi-configuration'];
      if (destination.regionalDeclaration ? configurationId !== destination.regionalDeclaration.configurationId : configurationId !== undefined) fail(403, 'REGIONAL_CONFIGURATION_MISMATCH');
      const method = req.headers['x-quixi-method'], path = req.headers['x-quixi-path'];
      const route = destination.routes.get(path);
      if (!route || !route.methods.has(method)) fail(403, 'UPSTREAM_ROUTE_DENIED');
      // Query parameters travel as one encoded header and are re-encoded
      // from parsed pairs; only the route's registered names may appear.
      let query = '';
      const rawQuery = req.headers['x-quixi-query'];
      if (rawQuery !== undefined) {
        if (typeof rawQuery !== 'string' || rawQuery.length > 2048 || /[^\x21-\x7e]/.test(rawQuery)) fail(403, 'UPSTREAM_QUERY_DENIED');
        const pairs = [...new URLSearchParams(rawQuery)];
        if (!pairs.length || pairs.length > 8 || pairs.some(([name, value]) => !route.query.has(name) || value.length > 256)) fail(403, 'UPSTREAM_QUERY_DENIED');
        query = new URLSearchParams(pairs).toString();
      }
      if (req.headers.cookie || req.headers['proxy-authorization'] || (destination.credential.header !== 'authorization' && req.headers[destination.credential.header]) || Object.keys(req.headers).some(h => h.startsWith('x-quixi-') && !wireHeaders.includes(h))) fail(400, 'CREDENTIAL_HEADER_OVERRIDE');
      if (req.headers.upgrade || String(req.headers.connection ?? '').toLowerCase().split(',').some(value => value.trim() && !['close', 'keep-alive'].includes(value.trim()))) fail(400, 'HOP_BY_HOP_HEADER_DENIED');
      if (destination.regionalDeclaration && Object.keys(req.headers).some(name => !transportHeaders.has(name) && !name.startsWith('sec-') && !wireHeaders.includes(name) && !route.headers.has(name))) fail(400, 'REGIONAL_HEADER_DENIED');
      const secret = req.headers['x-quixi-provider-authorization'];
      if ((destination.credential.required && !secret) || (secret !== undefined && (typeof secret !== 'string' || secret.length > 4096 || /[^\x21-\x7e]/.test(secret)))) fail(400, 'PROVIDER_CREDENTIAL_REQUIRED');
      const length = req.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > config.limits.maxUploadBytes)) fail(413, 'UPLOAD_LIMIT');
      if (method === 'GET' && ((length && Number(length) !== 0) || req.headers['transfer-encoding'])) fail(400, 'GET_BODY_DENIED');
      if (active >= config.limits.maxConcurrent || state.active >= principal.maxConcurrent) fail(429, 'CONCURRENCY_LIMIT');
      active++; state.active++; admitted = true; pending.add(controller);
      timer = setTimeout(() => abort(new Failure(504, 'TOTAL_TIMEOUT')), config.limits.totalMs); timer.unref(); resetIdle();
      // Resolution is performed once, checked by policy, and pinned into the
      // connection lookup. No subsequent system DNS lookup or redirect occurs.
      if (resolving >= config.limits.maxConcurrent) fail(503, 'DNS_ADMISSION_LIMIT');
      resolving++;
      const resolution = Promise.resolve().then(() => networkPolicy.resolve(destination.url)).finally(() => resolving--);
      const address = await waitAbort(resolution, signal);
      signal.throwIfAborted();
      const headers = {};
      for (const name of route.headers) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
      if (secret) headers[destination.credential.header] = destination.credential.prefix + secret;
      if (length !== undefined && method !== 'GET') headers['content-length'] = length;
      headers.host = destination.url.host;
      const transport = destination.url.protocol === 'https:' ? https : http;
      upstream = transport.request({
        protocol: destination.url.protocol, hostname: destination.url.hostname,
        // Controlled fixture hooks only: production policy defines neither, and
        // configuration cannot select them. Original TLS hostname is unchanged.
        port: networkPolicy.connectPort?.(destination.url) ?? (destination.url.port || undefined),
        ...(networkPolicy.tlsCA ? { ca: networkPolicy.tlsCA } : {}),
        path: query ? `${path}?${query}` : path, method, headers, agent: agents[destination.url.protocol], autoSelectFamily: false, family: address.family,
        lookup(hostname, options, callback) {
          if (hostname !== destination.url.hostname) { callback(new Error('Pinned hostname mismatch')); return; }
          if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
        },
      });
      upstream.on('error', () => {});
      const responsePromise = once(upstream, 'response', { signal }).then(([value]) => value);
      responsePromise.catch(() => {});
      // Headers and credentials remain buffered until the pinned socket is verified.
      const [socket] = await once(upstream, 'socket', { signal });
      await once(socket, destination.url.protocol === 'https:' ? 'secureConnect' : 'connect', { signal });
      if (socket.remoteAddress !== address.address) fail(502, 'PINNED_ADDRESS_MISMATCH');
      resetIdle();
      const upload = (async () => {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          signal.throwIfAborted(); bytesIn += chunk.length;
          if (bytesIn > config.limits.maxUploadBytes) fail(413, 'UPLOAD_LIMIT');
          if (method === 'GET' && chunk.length) fail(400, 'GET_BODY_DENIED');
          resetIdle();
          if (!upstream.write(chunk)) await once(upstream, 'drain', { signal });
        }
        upstream.end();
      })();
      upload.catch(error => abort(error));
      response = await waitAbort(responsePromise, signal); resetIdle();
      // Redirects are never followed and Location is never forwarded.
      if (response.statusCode >= 300 && response.statusCode < 400) fail(502, 'UPSTREAM_REDIRECT_DENIED');
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') fail(502, 'UPSTREAM_ENCODING_UNSUPPORTED');
      const responseLength = response.headers['content-length'];
      if (responseLength && Number(responseLength) > config.limits.maxResponseBytes) fail(502, 'RESPONSE_LIMIT');
      const outputHeaders = {};
      for (const name of safeResponseHeaders) if (typeof response.headers[name] === 'string') outputHeaders[name] = response.headers[name];
      res.writeHead(response.statusCode ?? 502, outputHeaders);
      for await (const chunk of response) {
        signal.throwIfAborted(); bytesOut += chunk.length;
        if (bytesOut > config.limits.maxResponseBytes) fail(502, 'RESPONSE_LIMIT');
        resetIdle();
        if (!res.write(chunk)) await once(res, 'drain', { signal });
      }
      await waitAbort(upload, signal);
      res.end();
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      code = reason instanceof Failure ? reason.code : 'UPSTREAM_UNAVAILABLE';
      const status = reason instanceof Failure ? reason.status : 502;
      abort(reason);
      if (!res.headersSent && !res.destroyed && status !== 499) {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close', ...(status === 429 ? { 'retry-after': '1' } : {}) });
        res.once('finish', () => { if (!req.complete) req.destroy(); });
        res.end(JSON.stringify({ error: { code }, requestId }));
      } else if (!res.writableFinished) { res.destroy(); req.destroy(); }
    } finally {
      clearTimeout(timer); clearTimeout(idleTimer);
      signal.removeEventListener('abort', destroyUpstream);
      req.off('aborted', disconnected); res.off('close', disconnected);
      if (admitted) { active--; state.active--; pending.delete(controller); }
      try { logger({ requestId, principalId: principal?.id, destinationId: destination?.id, status: res.statusCode, code, bytesIn, bytesOut, durationMs: Math.round(performance.now() - started) }); } catch { /* Diagnostics cannot change request behavior. */ }
    }
  }
  return { server, close: async () => { for (const controller of pending) controller.abort(new Failure(503, 'SHUTDOWN')); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }, stats: () => ({ active }) };
}
