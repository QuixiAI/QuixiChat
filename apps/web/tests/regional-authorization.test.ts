import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openAIRelayRegionalEvidence, createOpenAICompatibleAdapter, initialProviderCatalogs, adapterCatalog } from '@quixi/providers';
import { createWebHost } from '../src/host/index.ts';
import type { WebDestination } from '../src/host/index.ts';

const encode = (value: string) => new TextEncoder().encode(value);
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(holdEurope = false) {
  const europeEntered = gate(), europeRelease = gate();
  const requests: { destination: string; authorization: string | undefined; bytes: number }[] = [];
  const evidenceByDestination = new Map<string, ReturnType<typeof openAIRelayRegionalEvidence>>();
  const server = http.createServer(async (request, response) => {
    let bytes = 0; for await (const chunk of request) bytes += chunk.length;
    const destination = String(request.headers['x-quixi-destination']);
    requests.push({ destination, authorization: request.headers.authorization, bytes });
    const evidence = evidenceByDestination.get(destination)!;
    assert.equal(request.url, '/v1/regional-configuration'); assert(evidence);
    if (holdEurope && evidence.region === 'eu') { europeEntered.resolve(); await europeRelease.promise; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: 1, configurationId: evidence.relay!.configurationId, operator: evidence.relay!.operator, region: evidence.region, destinationId: destination, upstreamOrigin: evidence.upstreamOrigin }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const destinations: WebDestination[] = (['us', 'eu'] as const).map(region => {
    const evidence = openAIRelayRegionalEvidence(region, { configurationId: 'a'.repeat(64), operator: 'Synthetic regional operator', origin, region, destinationId: `openai_${region}` });
    evidenceByDestination.set(evidence.relay!.destinationId, evidence);
    return { binding: evidence.binding, baseUrl: origin, allowInsecureLoopback: true, relayDestinationId: evidence.relay!.destinationId,
      transport: { kind: 'relay', privacy: 'self_hosted_remote', relayIdentity: evidence.relay!.operator, regionalProcessing: evidence },
      credential: { header: 'Authorization', prefix: 'Bearer ' },
      routes: [{ path: '/v1/models', methods: ['GET'], headers: [] }, { path: '/v1/chat/completions', methods: ['POST'], headers: ['content-type'] }],
    };
  });
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const host = createWebHost({ destinations });
  for (const destination of destinations) await host.setRelayAuthorization(destination.binding.destinationId, encode(`synthetic-${destination.relayDestinationId}-initial`));
  return { host, destinations, origin, requests, europeEntered, europeRelease,
    async close() {
      europeRelease.resolve(); await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
    },
  };
}

test('a held older authorization replacement cannot overwrite a newer clear or replacement', { timeout: 10_000 }, async () => {
  for (const newer of [null, 'synthetic-newest-token']) {
    const f = await fixture(), originalFetch = globalThis.fetch, cancellationEntered = gate(), cancellationRelease = gate();
    let contentRequests = 0;
    // Metadata still uses actual loopback HTTP. Only the provider response reader
    // is controlled, to hold the real host transfer cancellation at its await.
    globalThis.fetch = async (input, init) => {
      if (String(input) === `${f.origin}/v1/provider-http`) {
        contentRequests++;
        return new Response(new ReadableStream<Uint8Array>({ cancel() { cancellationEntered.resolve(); return cancellationRelease.promise; } }), { status: 200 });
      }
      return originalFetch(input, init);
    };
    try {
      const destination = f.destinations[0]!;
      const response = await f.host.startProviderHttp({ requestId: crypto.randomUUID(), binding: destination.binding, method: 'GET', path: '/v1/models', headers: {}, credential: null, bodyTransferId: null, timeout: { connectMs: 5000, idleMs: 5000, totalMs: 10000 } });
      assert(response.bodyTransferId); assert.equal(contentRequests, 1);
      const older = f.host.setRelayAuthorization(destination.binding.destinationId, encode('synthetic-older-token'));
      await cancellationEntered.promise;
      await f.host.setRelayAuthorization(destination.binding.destinationId, newer === null ? null : encode(newer));
      cancellationRelease.resolve(); await older;
      const before = f.requests.length, capabilities = await f.host.capabilities();
      const current = capabilities.providerTransports.find(value => value.id === destination.binding.transportId)!;
      assert.equal(current.capability.available, newer !== null);
      const checked = f.requests.slice(before).filter(value => value.destination === destination.relayDestinationId);
      assert.equal(checked.length, newer === null ? 0 : 1);
      if (newer !== null) assert.equal(checked[0]!.authorization, `Bearer ${newer}`);
      assert.equal(contentRequests, 1, 'authorization changes never start another provider request');
    } finally { cancellationRelease.resolve(); globalThis.fetch = originalFetch; await f.close(); }
  }
});

test('capabilities discard an earlier successful region check when authorization changes during a later check', { timeout: 10_000 }, async () => {
  const f = await fixture(true);
  try {
    const pending = f.host.capabilities(); await f.europeEntered.promise;
    assert.equal(f.requests[0]!.destination, 'openai_us'); assert.equal(f.requests[1]!.destination, 'openai_eu');
    await f.host.setRelayAuthorization(f.destinations[0]!.binding.destinationId, null);
    f.europeRelease.resolve(); const capabilities = await pending;
    assert.equal(capabilities.providerTransports[0]!.capability.available, false);
    assert.equal(capabilities.providerTransports[1]!.capability.available, true);
    assert(f.requests.every(value => value.bytes === 0));
  } finally { await f.close(); }
});

test('disposing during a later regional check cannot publish an earlier successful capability', { timeout: 10_000 }, async () => {
  const f = await fixture(true);
  try {
    const pending = f.host.capabilities(); await f.europeEntered.promise;
    await f.host.dispose(); const capabilities = await pending;
    assert(capabilities.providerTransports.every(value => !value.capability.available));
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test('the final host guard refuses content when policy tightens during relay metadata verification', { timeout: 10_000 }, async () => {
  const f = await fixture(true), originalFetch = globalThis.fetch;
  let contentRequests = 0, allowed = true, checks = 0;
  const released: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === `${f.origin}/v1/provider-http`) { contentRequests++; return new Response('{}', { status: 200 }); }
    return originalFetch(input, init);
  };
  try {
    const destination = f.destinations[1]!;
    const adapter = createOpenAICompatibleAdapter({ host: { ...f.host, async releaseTransfer(requestId, transferId) { released.push(transferId); await f.host.releaseTransfer(requestId, transferId); } },
      binding: destination.binding, credential: null, catalog: adapterCatalog(initialProviderCatalogs()[0]!), nextId: () => crypto.randomUUID(), now: Date.now });
    const stream = adapter.stream({ requestId: crypto.randomUUID(), modelId: 'gpt-4.1-mini-2025-04-14', systemPrompt: null,
      messages: [{ role: 'user', parts: [{ id: crypto.randomUUID(), messageId: crypto.randomUUID(), order: 0, kind: 'Text', data: { text: 'Synthetic guarded regional input' } }] }], parameters: { maxOutputTokens: 128 } },
      async () => { checks++; if (!allowed) throw new Error('Regional policy tightened'); });
    const pending = (async () => { const values = []; for await (const event of stream.events) values.push(event); return values; })();
    await f.europeEntered.promise;
    assert.equal(checks, 1, 'the adapter initially admitted the reviewed request before host verification');
    allowed = false; f.europeRelease.resolve();
    const events = await pending, terminal = events.at(-1);
    assert.equal(checks, 2, 'the host must recheck after its metadata await');
    assert.equal(contentRequests, 0); assert(terminal?.type === 'terminal'); assert.equal(terminal.status, 'failed');
    assert.equal(released.length, 1, 'the adapter releases its staged body after final authorization fails');
    await assert.rejects(() => f.host.finishTransfer(crypto.randomUUID(), released[0]!, { byteLength: 0, sha256: '0'.repeat(64) }));
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.bytes, 0);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});
