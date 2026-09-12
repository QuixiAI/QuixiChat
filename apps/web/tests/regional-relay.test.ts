import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openAIRelayRegionalEvidence } from '@quixi/providers';
import { verifyRegionalRelay } from '../src/host/regional-relay.ts';
import { configuredWebProviders } from '../src/configuration.ts';
import { webProviderConnections } from '../src/host/provider-connections.ts';

const token = new TextEncoder().encode('synthetic-relay-authorization');
async function fixture(reply: (response: http.ServerResponse, expected: object) => void) {
  const requests: { url: string | undefined; method: string | undefined; headers: http.IncomingHttpHeaders; bytes: number }[] = [];
  let expected: object;
  const server = http.createServer(async (request, response) => {
    let bytes = 0; for await (const chunk of request) bytes += chunk.length;
    requests.push({ url: request.url, method: request.method, headers: request.headers, bytes });
    reply(response, expected);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const evidence = openAIRelayRegionalEvidence('us', { origin, operator: 'Synthetic operator', region: 'us', destinationId: 'openai-us', configurationId: 'a'.repeat(64) });
  expected = { version: 1, configurationId: evidence.relay!.configurationId, operator: evidence.relay!.operator, region: 'us', destinationId: 'openai-us', upstreamOrigin: evidence.upstreamOrigin };
  return { evidence, requests, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const json = (response: http.ServerResponse, value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };

test('regional metadata check sends only relay authorization and exact destination, with no request content', async () => {
  const f = await fixture(json);
  try {
    await verifyRegionalRelay(f.evidence, token);
    assert.equal(f.requests.length, 1);
    const request = f.requests[0]!;
    assert.equal(request.url, '/v1/regional-configuration'); assert.equal(request.method, 'POST'); assert.equal(request.bytes, 0);
    assert.equal(request.headers.authorization, 'Bearer synthetic-relay-authorization');
    assert.equal(request.headers['x-quixi-destination'], 'openai-us');
    assert.equal(request.headers['x-quixi-provider-authorization'], undefined);
    assert.equal(request.headers.cookie, undefined);
  } finally { await f.close(); }
});

test('unknown, altered, missing and expanded relay declarations fail closed', async () => {
  for (const change of [
    (value: any) => ({ ...value, version: 2 }), (value: any) => ({ ...value, configurationId: 'b'.repeat(64) }),
    (value: any) => ({ ...value, operator: 'Another operator' }), (value: any) => ({ ...value, region: 'eu' }),
    (value: any) => ({ ...value, destinationId: 'other' }), (value: any) => ({ ...value, upstreamOrigin: 'https://api.openai.com' }),
    (value: any) => ({ ...value, extra: true }), () => ({}), () => ([]), () => null,
  ]) {
    const f = await fixture((response, value) => json(response, change(value)));
    try { await assert.rejects(verifyRegionalRelay(f.evidence, token), /Regional relay verification failed/); }
    finally { await f.close(); }
  }
});

test('bounded declaration parsing rejects errors, redirects, oversized fixed/chunked bodies and malformed JSON', async () => {
  for (const reply of [
    (response: http.ServerResponse) => { response.writeHead(401); response.end('untrusted error'); },
    (response: http.ServerResponse) => { response.writeHead(307, { location: '/not-allowed' }); response.end(); },
    (response: http.ServerResponse) => { response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4097' }); response.end('x'.repeat(4097)); },
    (response: http.ServerResponse) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('x'.repeat(2048)); response.end('x'.repeat(2049)); },
    (response: http.ServerResponse) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{'); },
  ]) {
    const f = await fixture(reply);
    try { await assert.rejects(verifyRegionalRelay(f.evidence, token), /Regional relay verification failed/); assert.equal(f.requests.length, 1); }
    finally { await f.close(); }
  }
});

test('cancellation terminates a held declaration response without admitting it', async () => {
  let started!: () => void; const arrived = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(response => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); started(); });
  try {
    const controller = new AbortController(), checking = verifyRegionalRelay(f.evidence, token, controller.signal);
    await arrived; controller.abort(); await assert.rejects(checking, /Regional relay verification failed/);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

const config = () => ({ origin: 'https://relay.example.test', operator: 'Reviewed operator', privacy: 'self_hosted_remote' as const,
  destinations: { openai: 'global-openai', anthropic: 'global-anthropic' }, regional: [{ region: 'us' as const, destinationId: 'regional-us', configurationId: 'a'.repeat(64) }] });
test('operator configuration creates a separate regional binding and closed evidence while retaining global connections', () => {
  const configured = webProviderConnections(config());
  assert.deepEqual(configured.connections.map(value => value.id), ['openai', 'anthropic', 'openai-us-relay']);
  const regional = configured.destinations[2]!;
  assert.equal(regional.binding.destinationId, 'quixi-openai-us-relay-v1'); assert.equal(regional.relayDestinationId, 'regional-us');
  assert.equal(regional.transport.regionalProcessing?.relay?.configurationId, 'a'.repeat(64));
  assert.equal(regional.transport.regionalProcessing?.upstreamOrigin, 'https://us.api.openai.com');
  assert.deepEqual(regional.routes.map(value => value.path), ['/v1/models', '/v1/chat/completions']);
  const dual = webProviderConnections({ ...config(), regional: [config().regional[0]!, {
    region: 'eu', destinationId: 'regional-eu', configurationId: 'b'.repeat(64), origin: 'https://eu-relay.example.test', operator: 'European operator', privacy: 'custom_remote',
  }] });
  assert.equal(dual.connections[3]!.id, 'openai-eu-relay');
  assert.equal(dual.destinations[3]!.baseUrl, 'https://eu-relay.example.test');
  assert.equal(dual.destinations[3]!.transport.relayIdentity, 'European operator');
  assert.equal(dual.destinations[3]!.transport.privacy, 'custom_remote');
  assert.notDeepEqual(dual.destinations[2]!.binding, dual.destinations[3]!.binding);
});
test('invalid regional operator configuration leaves history startup available without live routes', () => {
  for (const change of [
    (value: any) => { value.regional[0].configurationId = 'unknown'; },
    (value: any) => { value.regional[0].region = 'global'; },
    (value: any) => { value.regional.push({ ...value.regional[0] }); },
    (value: any) => { value.regional[0].destinationId = value.destinations.openai; },
    (value: any) => { value.regional[0].upstreamOrigin = 'https://arbitrary.example'; },
    (value: any) => { value.origin = 'http://relay.example.test'; },
    (value: any) => { delete value.destinations.openai; },
    (value: any) => { value.regional[0].origin = 'http://remote.example.test'; },
    (value: any) => { value.regional[0].privacy = 'direct_provider'; },
  ]) {
    const value = config(); change(value); const result = configuredWebProviders(JSON.stringify(value));
    assert.match(result.notice!, /local history, imports, search and exports remain available/);
    assert.deepEqual(result.destinations, []);
  }
});
