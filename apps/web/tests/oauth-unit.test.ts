import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebHost, type WebHostConfig } from '../src/host/index.ts';
import { DiskStages } from '../src/host/disk-stages.ts';

const encode = (value: string) => new TextEncoder().encode(value);
const id = () => crypto.randomUUID();
const binding = { providerId: 'synthetic-oauth', accountId: 'test', destinationId: 'synthetic-resource', transportId: 'synthetic-browser' };
const appOrigin = 'https://app.synthetic.invalid';
const authOrigin = 'https://authorization.synthetic.invalid';
function gate<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function hostConfig(): WebHostConfig {
  return { destinations: [{ binding, baseUrl: 'https://resource.synthetic.invalid', routes: [{ path: '/resource', methods: ['GET'], headers: [] }], credential: { header: 'Authorization', prefix: 'Bearer ' }, transport: { kind: 'browser_direct', privacy: 'direct_provider', relayIdentity: null } }] };
}

test('replacing a session key cannot expose an empty binding to a concurrent new store', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const host = createWebHost(hostConfig());
  try {
    const original = await host.storeSecret(id(), binding, encode('synthetic-original'), null);
    const replacing = host.storeSecret(id(), binding, encode('synthetic-replacement'), original);
    const competing = host.storeSecret(id(), binding, encode('synthetic-competing'), null);
    const results = await Promise.allSettled([replacing, competing]);
    assert.equal(results[0]!.status, 'fulfilled');
    assert.equal(results[1]!.status, 'rejected');
    if (results[1]!.status === 'rejected') assert.equal(results[1]!.reason.code, 'CONFLICT');
    if (results[0]!.status === 'fulfilled') assert.deepEqual(await host.openSecret(id(), binding), results[0]!.value);
  } finally {
    await host.dispose();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

async function fixture(extraDestinations: WebHostConfig['destinations'] = []) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
  const originalFetch = globalThis.fetch;
  const opened = gate<URL>();
  const received = gate<RequestInit>();
  const popups: { closed: boolean; opener: unknown; location: { replace(value: string): void }; close(): void }[] = [];
  const navigations: { href: string; target: string; rel: string; referrerPolicy: string; appended: boolean; removed: boolean }[] = [];
  const channels: FakeChannel[] = [];
  class FakeChannel {
    closed = false;
    onmessage: ((event: MessageEvent) => void) | null = null;
    messages: unknown[] = [];
    constructor(readonly name: string) { channels.push(this); }
    postMessage(value: unknown) { if (this.closed) throw new Error('closed channel'); this.messages.push(value); }
    close() { this.closed = true; }
    deliver(url: string, origin = appOrigin, extra = {}) {
      this.onmessage?.(new MessageEvent('message', { origin, data: { type: 'quixi-oauth-callback', url, ...extra } }));
    }
  }
  const browser = Object.assign(new EventTarget(), {
    location: { origin: appOrigin }, isSecureContext: true, crossOriginIsolated: true,
    top: undefined as unknown,
    open() {
      const popup = { closed: false, opener: null as unknown,
        location: { replace(_value: string) { throw new Error('Authorization navigation must apply its own no-referrer policy.'); } },
        document: {
          createElement(tag: string) {
            assert.equal(tag, 'a');
            const link = { href: '', target: '', rel: '', referrerPolicy: '', appended: false, removed: false,
              click() { navigations.push(this); opened.resolve(new URL(this.href)); },
              remove() { this.removed = true; },
            };
            return link;
          },
          body: { append(link: { appended: boolean }) { link.appended = true; } },
        },
        close() { this.closed = true; },
      };
      popups.push(popup); return popup;
    },
  });
  browser.top = browser;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: FakeChannel });
  const calls: { url: string; init: RequestInit }[] = [];
  let respond: (init: RequestInit) => Promise<Response> = async () => new Response(JSON.stringify({ access_token: 'synthetic-oauth-access', token_type: 'Bearer', scope: 'profile', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => { calls.push({ url: String(input), init }); received.resolve(init); return respond(init); };
  const config: WebHostConfig = { ...hostConfig(), destinations: [...hostConfig().destinations, ...extraDestinations], oauthConfigurations: [{ id: 'synthetic', binding, authorizationEndpoint: authOrigin + '/authorize', tokenEndpoint: authOrigin + '/token', redirectUri: appOrigin + '/oauth/callback.html', issuer: authOrigin, clientId: 'synthetic-public-client', allowedScopes: ['profile'], timeoutMs: 5000 }] };
  const host = createWebHost(config);
  function start() {
    const requestId = id();
    const pending = host.startOAuth({ requestId, providerId: binding.providerId, configurationId: 'synthetic', scopes: ['profile'] });
    void pending.catch(() => {});
    return { requestId, pending };
  }
  function callback(authorization: URL, changes: Record<string, string> = {}) {
    return appOrigin + '/oauth/callback.html?' + new URLSearchParams({ state: authorization.searchParams.get('state')!, iss: authOrigin, code: 'synthetic-code', ...changes });
  }
  return { host, browser, config, start, callback, channels, calls, popups, navigations, opened, received,
    respond(value: typeof respond) { respond = value; },
    async close() {
      try { await host.dispose(); } finally {
        globalThis.fetch = originalFetch;
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
        if (originalChannel) Object.defineProperty(globalThis, 'BroadcastChannel', originalChannel); else Reflect.deleteProperty(globalThis, 'BroadcastChannel');
      }
    },
  };
}

test('OAuth reserves the popup before WebCrypto and publishes only one opaque session handle', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const active = f.start();
    assert.equal(f.popups.length, 1, 'popup must open before the first asynchronous digest');
    const authorization = await f.opened.promise;
    assert.equal(f.navigations.length, 1);
    assert.equal(f.navigations[0]!.target, '_self');
    assert.equal(f.navigations[0]!.rel, 'noreferrer');
    assert.equal(f.navigations[0]!.referrerPolicy, 'no-referrer');
    assert(f.navigations[0]!.appended);
    assert(f.navigations[0]!.removed);
    assert.equal(authorization.origin, authOrigin);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('state')!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(f.channels[0]!.name, 'quixi-oauth-v1:' + authorization.searchParams.get('state'));
    f.channels[0]!.deliver(f.callback(authorization));
    f.channels[0]!.deliver(f.callback(authorization));
    const result = await active.pending;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.url, authOrigin + '/token');
    const init = f.calls[0]!.init;
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer');
    const body = new URLSearchParams(String(init.body));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encode(body.get('code_verifier')!)));
    assert.equal(Buffer.from(digest).toString('base64url'), authorization.searchParams.get('code_challenge'));
    assert.equal(body.get('redirect_uri'), appOrigin + '/oauth/callback.html');
    assert.equal(body.has('client_secret'), false);
    assert.deepEqual(Object.keys(result.credential).sort(), ['binding', 'id', 'persistence']);
    assert.equal(result.credential.persistence, 'session');
    assert.equal(JSON.stringify(result).includes('synthetic-oauth-access'), false);
    assert.deepEqual(await f.host.openSecret(id(), binding), result.credential);
    assert(f.channels[0]!.closed);
    assert.equal((await f.host.cancel(active.requestId)).outcome, 'already_completed');
  } finally { await f.close(); }
});

function persistedEvent(type: 'pagehide' | 'pageshow'): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: true });
  return event;
}
async function resumed(host: ReturnType<typeof createWebHost>): Promise<void> {
  const end = performance.now() + 2000;
  while (performance.now() < end) {
    try { await host.openSecret(id(), binding); return; } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'CLOSED')) throw error;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('persisted pageshow never resumed the cleaned host');
}

test('BFCache restore discards session secrets and pending OAuth while allowing a fresh connection', { timeout: 10000 }, async () => {
  const f = await fixture(), response = gate<Response>();
  f.respond(() => response.promise);
  try {
    const active = f.start(), authorization = await f.opened.promise;
    f.channels[0]!.deliver(f.callback(authorization)); await f.received.promise;
    f.browser.dispatchEvent(persistedEvent('pagehide'));
    await assert.rejects(active.pending);
    await assert.rejects(f.host.openSecret(id(), binding), (error: any) => error.code === 'CLOSED');
    f.browser.dispatchEvent(persistedEvent('pageshow'));
    await resumed(f.host);
    const fresh = await f.host.storeSecret(id(), binding, encode('synthetic-after-restore'), null);
    response.resolve(new Response(JSON.stringify({ access_token: 'synthetic-pre-restore', token_type: 'Bearer' })));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await f.host.openSecret(id(), binding), fresh);
    f.browser.dispatchEvent(persistedEvent('pagehide'));
    f.browser.dispatchEvent(persistedEvent('pageshow'));
    await resumed(f.host);
    assert.equal(await f.host.openSecret(id(), binding), null, 'a second suspension clears the restored session too');
  } finally { response.resolve(new Response('{}')); await f.close(); }
});

test('BFCache waits for late disk admission release and permanent disposal cannot be undone by pageshow', { timeout: 10000 }, async () => {
  const originalBegin = DiskStages.prototype.begin, originalRelease = DiskStages.prototype.release, originalOwns = DiskStages.prototype.owns;
  for (const permanent of [false, true]) {
    const admitted = gate(), releaseEntered = gate(), releaseAllowed = gate();
    const lateId = id(), released: string[] = [];
    // Only the asynchronous disk adapter edge is controlled; the actual host
    // and WebTransfers admission, cancellation and lifecycle logic runs.
    DiskStages.prototype.begin = async () => { await admitted.promise; return { transferId: lateId, maxChunkBytes: 65536, maxInFlight: 4 }; };
    DiskStages.prototype.owns = transferId => transferId === lateId;
    DiskStages.prototype.release = async transferId => { released.push(transferId); releaseEntered.resolve(); await releaseAllowed.promise; };
    const f = await fixture();
    let closing: Promise<void> | undefined;
    try {
      const pending = f.host.beginTransfer(id(), { purpose: 'file_save', expectedBytes: 0, expectedSha256: null }); void pending.catch(() => {});
      f.browser.dispatchEvent(persistedEvent('pagehide'));
      f.browser.dispatchEvent(persistedEvent('pageshow'));
      await assert.rejects(f.host.openSecret(id(), binding), (error: any) => error.code === 'CLOSED');
      admitted.resolve(); await releaseEntered.promise;
      assert.deepEqual(released, [lateId]);
      await assert.rejects(f.host.openSecret(id(), binding), (error: any) => error.code === 'CLOSED');
      if (permanent) closing = f.host.dispose();
      else f.browser.dispatchEvent(persistedEvent('pagehide')); // A second navigation supersedes the earlier pageshow.
      releaseAllowed.resolve(); await assert.rejects(pending);
      if (permanent) {
        await closing; f.browser.dispatchEvent(persistedEvent('pageshow'));
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(f.host.openSecret(id(), binding), (error: any) => error.code === 'CLOSED');
      } else {
        await new Promise(resolve => setImmediate(resolve));
        await assert.rejects(f.host.openSecret(id(), binding), (error: any) => error.code === 'CLOSED');
        f.browser.dispatchEvent(persistedEvent('pageshow'));
        await resumed(f.host);
        await assert.rejects(f.host.writeChunk({ transferId: lateId, sequence: 0, offset: 0, final: true, bytes: new Uint8Array() }), (error: any) => error.code === 'NOT_FOUND');
        const transfer = await f.host.beginTransfer(id(), { purpose: 'provider_request', expectedBytes: 0, expectedSha256: null });
        await f.host.releaseTransfer(id(), transfer.transferId);
      }
    } finally {
      admitted.resolve(); releaseAllowed.resolve(); await closing; await f.close();
      DiskStages.prototype.begin = originalBegin; DiskStages.prototype.release = originalRelease; DiskStages.prototype.owns = originalOwns;
    }
  }
});

test('transfer admissions stay bounded and failed late cleanup prevents BFCache resumption', { timeout: 10000 }, async () => {
  const originalBegin = DiskStages.prototype.begin, originalRelease = DiskStages.prototype.release, originalOwns = DiskStages.prototype.owns;
  const admitted = gate(), allocated = new Set<string>(), released = new Set<string>();
  DiskStages.prototype.begin = async () => { const transferId = id(); allocated.add(transferId); await admitted.promise; return { transferId, maxChunkBytes: 65536, maxInFlight: 4 }; };
  DiskStages.prototype.owns = transferId => allocated.has(transferId);
  DiskStages.prototype.release = async transferId => { released.add(transferId); throw new Error('synthetic release failure'); };
  const f = await fixture();
  try {
    const pending = Array.from({ length: 16 }, () => f.host.beginTransfer(id(), { purpose: 'file_save', expectedBytes: 0, expectedSha256: null }));
    const outcomes = Promise.allSettled(pending);
    await assert.rejects(f.host.beginTransfer(id(), { purpose: 'file_save', expectedBytes: 0, expectedSha256: null }), (error: any) => error.code === 'OVERLOADED');
    assert.equal(allocated.size, 16);
    f.browser.dispatchEvent(persistedEvent('pagehide'));
    f.browser.dispatchEvent(persistedEvent('pageshow'));
    admitted.resolve();
    assert((await outcomes).every(value => value.status === 'rejected'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released.size, 16);
    f.browser.dispatchEvent(persistedEvent('pageshow'));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.host.openSecret(id(), binding), (error: any) => error.code === 'CLOSED');
  } finally {
    admitted.resolve();
    await assert.rejects(f.close(), (error: any) => error.code === 'IO_ERROR');
    DiskStages.prototype.begin = originalBegin; DiskStages.prototype.release = originalRelease; DiskStages.prototype.owns = originalOwns;
  }
});

test('a relay-token replacement suspended in reader cleanup cannot resurrect after BFCache resume', { timeout: 10000 }, async () => {
  const relayBinding = { ...binding, destinationId: 'synthetic-relay', transportId: 'synthetic-relay-transport' };
  const f = await fixture([{ binding: relayBinding, baseUrl: 'https://relay.synthetic.invalid', relayDestinationId: 'synthetic-provider', routes: [{ path: '/resource', methods: ['GET'], headers: [] }], credential: { header: 'Authorization', prefix: 'Bearer ' }, transport: { kind: 'relay', privacy: 'self_hosted_remote', relayIdentity: 'Synthetic relay' } }]);
  const cancelled = gate(), release = gate();
  f.respond(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); return release.promise; } })));
  try {
    await f.host.setRelayAuthorization(relayBinding.destinationId, encode('synthetic-initial-relay'));
    await f.host.startProviderHttp({ requestId: id(), binding: relayBinding, method: 'GET', path: '/resource', headers: {}, credential: null, bodyTransferId: null, timeout: { connectMs: 1000, idleMs: 5000, totalMs: 10000 } });
    const replacement = f.host.setRelayAuthorization(relayBinding.destinationId, encode('synthetic-stale-relay')); void replacement.catch(() => {});
    await cancelled.promise;
    f.browser.dispatchEvent(persistedEvent('pagehide'));
    f.browser.dispatchEvent(persistedEvent('pageshow'));
    await resumed(f.host);
    release.resolve(); await Promise.allSettled([replacement]);
    const capability = (await f.host.capabilities()).providerTransports.find(value => value.id === relayBinding.transportId)!;
    assert.equal(capability.capability.available, false, 'pre-suspension relay replacement must not restore its token');
  } finally { release.resolve(); await f.close(); }
});

test('unrelated or malformed callbacks do not consume the pending authorization', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const active = f.start(), authorization = await f.opened.promise, valid = f.callback(authorization);
    for (const malformed of [f.callback(authorization, { state: 'wrong' }), f.callback(authorization, { iss: 'https://other.invalid' }), valid + '&state=again', valid + '&unexpected=x', valid + '#fragment', valid.replace('state=', '%73tate='), valid.replace('synthetic-code', '%FF'), valid.replace('/callback.html?', '/other.html?'), valid.replace('synthetic-code', 'x'.repeat(4097))]) f.channels[0]!.deliver(malformed);
    f.channels[0]!.deliver(valid, 'https://other.invalid');
    f.channels[0]!.deliver(valid, appOrigin, { unexpected: true });
    assert.equal(f.calls.length, 0);
    f.channels[0]!.deliver(valid);
    await active.pending;
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('late valid token responses cannot publish after cancellation, connection changes or owner loss', { timeout: 10000 }, async () => {
  for (const action of ['cancel', 'manual', 'deleteMissing', 'dispose', 'pagehide'] as const) {
    const f = await fixture(), response = gate<Response>();
    f.respond(() => response.promise); // Deliberately ignore abort to exercise host-side late-result checks.
    try {
      const active = f.start(), authorization = await f.opened.promise;
      f.channels[0]!.deliver(f.callback(authorization)); await f.received.promise;
      let manual;
      if (action === 'cancel') {
        const cancellation = await f.host.cancel(active.requestId);
        assert.equal(cancellation.outcome, 'cancelled'); assert.equal(cancellation.externalEffect, 'may_have_occurred');
      } else if (action === 'manual') manual = await f.host.storeSecret(id(), binding, encode('synthetic-manual'), null);
      else if (action === 'deleteMissing') await f.host.deleteSecret(id(), { id: id(), persistence: 'session', binding });
      else if (action === 'pagehide') f.browser.dispatchEvent(new Event('pagehide'));
      else await f.host.dispose();
      response.resolve(new Response(JSON.stringify({ access_token: 'synthetic-late-token', token_type: 'Bearer' })));
      await assert.rejects(active.pending);
      await new Promise(resolve => setImmediate(resolve));
      if (action !== 'dispose' && action !== 'pagehide') assert.deepEqual(await f.host.openSecret(id(), binding), manual ?? null);
      else await assert.rejects(f.host.openSecret(id(), binding), (error: any) => error.code === 'CLOSED');
      assert(f.channels[0]!.closed);
      assert.equal(f.calls.length, 1);
    } finally { response.resolve(new Response('{}')); await f.close(); }
  }
});

test('the active transaction snapshots caller request and composition registration before asynchronous work', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const originalId = id();
    const request = { requestId: originalId, providerId: binding.providerId, configurationId: 'synthetic', scopes: ['profile'] };
    const pending = f.host.startOAuth(request); void pending.catch(() => {});
    request.requestId = id(); request.providerId = 'changed'; request.scopes.push('offline_access');
    f.config.oauthConfigurations![0]!.tokenEndpoint = 'https://unreviewed.invalid/token';
    f.config.oauthConfigurations![0]!.binding.accountId = 'changed';
    const authorization = await f.opened.promise;
    assert.equal(authorization.searchParams.get('scope'), 'profile');
    f.channels[0]!.deliver(f.callback(authorization));
    const result = await pending;
    assert.equal(result.requestId, originalId);
    assert.equal(result.binding.accountId, 'test');
    assert.equal(f.calls[0]!.url, authOrigin + '/token');
  } finally { binding.accountId = 'test'; await f.close(); }
});

test('cancellation while PKCE digest is pending closes admission without authorization or token dispatch', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const active = f.start();
    const cancellation = await f.host.cancel(active.requestId);
    await assert.rejects(active.pending);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancellation.outcome, 'cancelled');
    assert.equal(cancellation.externalEffect, 'not_dispatched');
    assert.equal(f.calls.length, 0);
    assert(f.channels[0]!.closed);
    assert(f.popups[0]!.closed);
  } finally { await f.close(); }
});

test('invalid token JSON and widened scopes never create a credential', { timeout: 10000 }, async () => {
  const cases = [
    '{"access_token":"first","access_token":"second","token_type":"Bearer"}',
    '{"access_token":"first","access_\\u0074oken":"second","token_type":"Bearer"}',
    '{"access_token":"synthetic","token_type":"Basic","token_type":"Bearer"}',
    JSON.stringify({ access_token: 'synthetic', token_type: 'Bearer', unknown: true }),
    JSON.stringify({ access_token: 'synthetic', token_type: 'Bearer', scope: 'profile offline_access' }),
    JSON.stringify({ access_token: 'synthetic', token_type: 'Bearer', scope: null }),
    JSON.stringify({ access_token: 'synthetic', token_type: 'Bearer', expires_in: 0 }),
    JSON.stringify({ access_token: 'x'.repeat(16385), token_type: 'Bearer' }),
    JSON.stringify({ access_token: 'two words', token_type: 'Bearer' }),
    '{"access_token":"synthetic","token_type":"Bearer"' + ' '.repeat(32768),
  ];
  for (const body of cases) {
    const f = await fixture(); f.respond(async () => new Response(body));
    try {
      const active = f.start(), authorization = await f.opened.promise;
      f.channels[0]!.deliver(f.callback(authorization));
      await assert.rejects(active.pending);
      assert.equal(await f.host.openSecret(id(), binding), null);
    } finally { await f.close(); }
  }
});

test('header rejection cancels a token response body before exposing bytes', { timeout: 10000 }, async () => {
  const f = await fixture(); let cancelled = false;
  f.respond(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { headers: { 'x-oversized': 'x'.repeat(8193) } }));
  try {
    const active = f.start(), authorization = await f.opened.promise;
    f.channels[0]!.deliver(f.callback(authorization));
    await assert.rejects(active.pending);
    await new Promise(resolve => setImmediate(resolve));
    assert(cancelled, 'rejected headers must release the response stream even before a reader is assigned');
    assert.equal(await f.host.openSecret(id(), binding), null);
  } finally { await f.close(); }
});
