import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createServer, build } from 'vite';
import { callbackHeaders } from '../vite.config.ts';

const appOrigin = 'http://127.0.0.1:4216', authOrigin = 'http://127.0.0.1:4217';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const fixtureDist = resolve(root, '../../test-results/web-oauth-fixture');
await build({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir: fixtureDist, emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, 'oauth-fixture.html') } } });
const runs = new Map();
const digest = value => createHash('sha256').update(value).digest('base64url');
function run(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid fixture ID');
  if (!runs.has(id)) runs.set(id, { authorizations: [], tokens: [], providers: [], callbacks: 0, codes: new Map(), accessToken: 'synthetic-access-' + randomUUID(), release: null });
  return runs.get(id);
}
function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
function authorizationPage(response, state, mode, record) {
  const code = 'synthetic-code-' + randomUUID(); record.codes.set(code, state.challenge);
  const query = new URLSearchParams({ state: mode === 'bad-state' ? 'A'.repeat(43) : state.state, iss: mode === 'bad-issuer' ? authOrigin + '/wrong-issuer' : authOrigin });
  query.set(mode === 'denied' ? 'error' : 'code', mode === 'denied' ? 'access_denied' : code);
  if (mode === 'duplicate-query') query.append('state', state.state);
  const callback = appOrigin + (mode === 'bad-path' ? '/oauth/wrong.html' : '/oauth/callback.html') + '?' + query;
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': 'synthetic-auth-cookie=must-not-reach-token; SameSite=Lax; Path=/' });
  response.end('<!doctype html><meta name="referrer" content="no-referrer"><title>Synthetic authorization</title><h1>Synthetic authorization</h1><button id="approve">Approve synthetic authorization</button><script>document.getElementById("approve").onclick=()=>location.assign(' + JSON.stringify(callback) + ')</script>');
}
const auth = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url, authOrigin), [, operation, id, mode = 'success'] = url.pathname.split('/');
    const record = run(id);
    if (request.headers.origin === appOrigin) response.setHeader('Access-Control-Allow-Origin', appOrigin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'content-type, authorization' }); response.end(); return; }
    if (operation === 'authorize') {
      const one = name => url.searchParams.getAll(name).length === 1 ? url.searchParams.get(name) : null;
      const state = { state: one('state'), challenge: one('code_challenge') };
      const valid = one('response_type') === 'code' && one('client_id') === 'quixi-web-oauth-proof' && one('redirect_uri') === appOrigin + '/oauth/callback.html' && one('scope') === 'profile' && one('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(state.state ?? '') && /^[A-Za-z0-9_-]{43}$/.test(state.challenge ?? '');
      record.authorizations.push({ valid, referrerPresent: !!request.headers.referer, cookiePresent: !!request.headers.cookie, queryNames: [...url.searchParams.keys()].sort() });
      if (!valid) { json(response, { valid: false }, 400); return; }
      record.state = state;
      authorizationPage(response, state, mode, record); return;
    }
    if (operation === 'recover') { authorizationPage(response, record.state, 'success', record); return; }
    if (operation === 'away') { response.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer' }); response.end('<!doctype html><title>Synthetic navigation target</title><p>Synthetic navigation target</p>'); return; }
    if (operation === 'token') {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 16384) { request.destroy(); return; } chunks.push(chunk); }
      const body = new URLSearchParams(Buffer.concat(chunks).toString()), one = name => body.getAll(name).length === 1 ? body.get(name) : null;
      const challenge = record.codes.get(one('code')); record.codes.delete(one('code'));
      const entry = { method: request.method, codeKnown: !!challenge, pkceMatches: !!challenge && digest(one('code_verifier') ?? '') === challenge, clientMatches: one('client_id') === 'quixi-web-oauth-proof', redirectMatches: one('redirect_uri') === appOrigin + '/oauth/callback.html', grantMatches: one('grant_type') === 'authorization_code', originMatches: request.headers.origin === appOrigin, referrerPresent: !!request.headers.referer, cookiePresent: !!request.headers.cookie, authorizationPresent: !!request.headers.authorization, bodyBytes: length, mode, released: false };
      record.tokens.push(entry);
      if (!entry.pkceMatches || !entry.clientMatches || !entry.redirectMatches || !entry.grantMatches) { json(response, { invalid: true }, 400); return; }
      if (mode === 'held') await new Promise(resolve => { record.release = resolve; setTimeout(resolve, 12000).unref(); });
      entry.released = true;
      if (mode === 'redirect-token') { response.writeHead(302, { Location: authOrigin + '/unexpected/' + id }); response.end(); return; }
      if (mode === 'malformed-token') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{'); return; }
      json(response, { access_token: mode === 'oversize-token' ? 'A'.repeat(65536) : record.accessToken, token_type: mode === 'invalid-token' ? 'NotBearer' : 'Bearer', expires_in: 3600, ...(mode === 'auxiliary-tokens' ? { refresh_token: 'synthetic-refresh-discarded', id_token: 'synthetic-id-discarded' } : {}) }); return;
    }
    if (operation === 'resource') {
      const credentialKind = request.headers.authorization === 'Bearer ' + record.accessToken ? 'issued' : request.headers.authorization === 'Bearer synthetic-manual-secret' ? 'manual' : 'invalid';
      record.providers.push({ method: request.method, credentialKind, referrerPresent: !!request.headers.referer, cookiePresent: !!request.headers.cookie }); json(response, { authorized: credentialKind !== 'invalid' }, credentialKind === 'invalid' ? 401 : 200); return;
    }
    record.unexpected = (record.unexpected ?? 0) + 1; json(response, { unexpected: true }, 404);
  } catch { json(response, { fixtureFailure: true }, 500); }
});
await new Promise(resolve => auth.listen(4217, '127.0.0.1', resolve));
const server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 4216, strictPort: true, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } }, plugins: [{ name: 'isolated-oauth-fixture', configureServer(server) { server.middlewares.use(async (request, response, next) => {
  const url = new URL(request.url, appOrigin);
  if (url.pathname === '/tests/oauth-fixture.html' || url.pathname === '/tests/oauth-unisolated.html') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', ...(url.pathname.endsWith('unisolated.html') ? { 'Cross-Origin-Opener-Policy': 'unsafe-none', 'Cross-Origin-Embedder-Policy': 'unsafe-none' } : {}) }); response.end(await readFile(resolve(fixtureDist, 'oauth-fixture.html'))); return;
  }
  if (url.pathname.startsWith('/oauth-fixture/')) {
    const [, , operation, id] = url.pathname.split('/'); const record = run(id);
    if (operation === 'away') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }); response.end('<!doctype html><title>Synthetic navigation target</title><p>Synthetic navigation target</p>'); return; }
    if (operation === 'release') { record.release?.(); json(response, { released: true }); return; }
    if (operation === 'stats') { json(response, { authorizations: record.authorizations, tokens: record.tokens, providers: record.providers, unexpected: record.unexpected ?? 0 }); return; }
  }
  if (url.pathname === '/oauth/callback.html' || url.pathname === '/oauth/wrong.html' || url.pathname.startsWith('/assets/')) {
    const relative = url.pathname === '/oauth/wrong.html' ? '/oauth/callback.html' : url.pathname;
    const path = resolve(dist, '.' + relative);
    if (!path.startsWith(dist + '/')) { response.writeHead(404); response.end(); return; }
    try { const bytes = await readFile(path).catch(error => url.pathname.startsWith('/assets/') ? readFile(resolve(fixtureDist, '.' + url.pathname)) : Promise.reject(error)); response.writeHead(200, { ...callbackHeaders, 'Content-Type': extname(path) === '.html' ? 'text/html' : extname(path) === '.js' ? 'application/javascript' : 'application/octet-stream' }); response.end(bytes); return; } catch { response.writeHead(404); response.end(); return; }
  }
  next();
}); } }] });
await server.listen();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { for (const record of runs.values()) record.release?.(); await server.close(); auth.close(); process.exit(0); });
