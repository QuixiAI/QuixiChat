import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { initialProviderCatalogs, openAIRegionalEvidence } from '@quixi/providers';
import { createProviderSettingsController } from '../controller.ts';

const epoch = 1_800_000_000_000;
const available = { available: true, permission: 'not_required', reason: null };
const active = { online: true, visible: true, busy: false };
async function until(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await delay(2);
  assert.ok(predicate(), message);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { provider = 'openai', regional = false } = {}) {
  let now = epoch;
  const evidence = regional ? openAIRegionalEvidence('us') : null;
  const binding = evidence?.binding ?? { providerId: provider, accountId: 'synthetic', destinationId: `synthetic-${provider}`, transportId: `synthetic-${provider}` };
  const catalog = initialProviderCatalogs().find(value => value.providerId === provider);
  assert.ok(catalog);
  let transport = { id: binding.transportId, capability: available, kind: 'native_direct', privacy: 'direct_provider', endpointOrigin: evidence?.upstreamOrigin ?? `https://api.${provider}.com`, relayIdentity: null, ...(evidence ? { regionalProcessing: evidence } : {}) };
  let stored = { id: crypto.randomUUID(), persistence: 'native', binding };
  const queued = [], requests = [], released = [], cancelled = [], changes = [], bodies = new Map(), holds = new Set();
  let capabilityReads = 0, notifications = 0;
  function response(request, spec) {
    const bodyTransferId = crypto.randomUUID(), status = spec.status ?? 200;
    bodies.set(bodyTransferId, new TextEncoder().encode(JSON.stringify(spec.body ?? (status === 200 ? { data: [{ id: catalog.model.id }] } : { error: { message: 'Synthetic refusal' } }))));
    return { requestId: request.requestId, status, headers: { 'content-type': 'application/json', ...(spec.retryAfter ? { 'retry-after': spec.retryAfter } : {}) }, bodyTransferId };
  }
  const host = {
    async capabilities() { capabilityReads++; return { host: 'desktop', secretPersistence: 'native', providerTransports: [structuredClone(transport)] }; },
    async openSecret() { return structuredClone(stored); },
    async storeSecret(_id, value) { stored = { id: crypto.randomUUID(), persistence: 'native', binding: value }; return structuredClone(stored); },
    async deleteSecret() { stored = null; },
    async startProviderHttp(request, beforeDispatch) {
      await beforeDispatch?.();
      assert.equal(request.method, 'GET');
      assert.equal(request.path, '/v1/models');
      assert.equal(request.bodyTransferId, null);
      const spec = queued.shift() ?? {};
      requests.push({ ...request, startedAt: now });
      if (spec.hold) await spec.hold.promise;
      return response(request, spec);
    },
    async readChunk(transferId) { assert.ok(bodies.has(transferId)); return { transferId, sequence: 0, offset: 0, bytes: bodies.get(transferId), final: true }; },
    async acknowledgeChunk() {},
    async releaseTransfer(_requestId, transferId) { assert.ok(bodies.has(transferId)); released.push(transferId); bodies.delete(transferId); },
    async cancel(requestId) { cancelled.push(requestId); return { requestId, outcome: 'cancelled', externalEffect: 'may_have_occurred' }; },
  };
  const controller = createProviderSettingsController({ host, credentialCapability: available, now: () => now, onChange: value => changes.push(value), connections: [{ id: 'connection', label: 'Synthetic connection', binding, catalog, relayAuthorizationRequired: false, ...(regional ? { processingRegion: 'us' } : {}) }] });
  controller.subscribe(() => { notifications++; });
  t.after(async () => { for (const hold of holds) hold.resolve(); await controller.dispose(); });
  await controller.initialize();
  return {
    controller, host, requests, changes, cancelled, released, bodies, queued,
    get notifications() { return notifications; },
    get capabilityReads() { return capabilityReads; },
    get now() { return now; },
    at(time, activity = active) { now = time; controller.setActivity(activity); },
    changeTransport(change) { transport = change(structuredClone(transport)); },
    hold(spec = {}) { const hold = deferred(); holds.add(hold); queued.push({ ...spec, hold }); return () => { hold.resolve(); holds.delete(hold); }; },
    async settled(count) { await until(() => requests.length === count && released.length === count && controller.getSnapshot().connections[0].health?.observedAt === now, `probe ${count} published and released`); await delay(3); },
  };
}

test('first automatic probe publishes real health at 30 seconds and does not discover models', async t => {
  const f = await fixture(t, { provider: 'anthropic' });
  const adapter = f.changes.at(-1)[0].adapter, before = f.notifications;
  f.queued.push({ body: { data: [{ id: 'synthetic-unreviewed' }], has_more: true, last_id: 'synthetic-unreviewed' } });
  f.at(epoch + 29_999); await delay(8);
  assert.equal(f.requests.length, 0);
  f.at(epoch + 30_000); await f.settled(1);
  assert.equal(f.requests[0].query.after_id, undefined, 'only the first metadata page is requested');
  assert.ok(Number(f.requests[0].query.limit) > 0);
  const view = f.controller.getSnapshot().connections[0];
  assert.equal(view.busy, false);
  assert.equal(view.health.status, 'healthy');
  assert.equal(view.health.evidence, 'models_probe');
  assert.equal(view.discovery, null);
  assert.equal(f.changes.at(-1)[0].adapter, adapter);
  assert.deepEqual(adapter.accountHealth(), view.health);
  assert.ok(f.notifications > before);
  assert.equal(f.bodies.size, 0);
  f.at(epoch + 329_999); await delay(8); assert.equal(f.requests.length, 1);
  f.at(epoch + 330_000); await f.settled(2);
});

test('automatic refresh preserves the last explicit model discovery', async t => {
  const f = await fixture(t, { provider: 'anthropic' });
  f.queued.push({ body: { data: [{ id: 'first-unreviewed' }], has_more: true, last_id: 'first-unreviewed' } }, { body: { data: [{ id: 'second-unreviewed' }], has_more: false } });
  await f.controller.check('connection');
  const discovery = structuredClone(f.controller.getSnapshot().connections[0].discovery);
  assert.equal(discovery.pages, 2);
  assert.equal(f.requests[1].query.after_id, 'first-unreviewed');
  f.queued.push({ body: { data: [{ id: 'replacement-unreviewed' }], has_more: true, last_id: 'replacement-unreviewed' } });
  f.at(epoch + 300_000); await f.settled(3);
  assert.deepEqual(f.controller.getSnapshot().connections[0].discovery, discovery);
  assert.equal(f.requests[2].query.after_id, undefined);
});

for (const [label, activity] of [['offline', { ...active, online: false }], ['hidden', { ...active, visible: false }], ['foreground busy', { ...active, busy: true }]]) {
  test(`${label} suppresses an overdue probe until activity resumes`, async t => {
    const f = await fixture(t);
    f.at(epoch + 600_000, activity); await delay(10);
    assert.equal(f.requests.length, 0);
    f.controller.setActivity(active); await f.settled(1);
    assert.equal(f.requests[0].startedAt, epoch + 600_000);
  });
}

test('rate limits honor Retry-After and repeated failures back off before recovery', async t => {
  const f = await fixture(t);
  f.queued.push({ status: 429, retryAfter: '90' }, { status: 503 }, { status: 503 }, {});
  f.at(epoch + 30_000); await f.settled(1);
  assert.equal(f.controller.health('connection').status, 'rate_limited');
  assert.equal(f.controller.health('connection').retryAt, epoch + 120_000);
  f.at(epoch + 119_999); await delay(8); assert.equal(f.requests.length, 1);
  f.at(epoch + 120_000); await f.settled(2);
  assert.equal(f.controller.health('connection').status, 'provider_degraded');
  f.at(epoch + 179_999); await delay(8); assert.equal(f.requests.length, 2);
  f.at(epoch + 180_000); await f.settled(3);
  f.at(epoch + 299_999); await delay(8); assert.equal(f.requests.length, 3);
  f.at(epoch + 300_000); await f.settled(4);
  assert.equal(f.controller.health('connection').status, 'healthy');
  f.at(epoch + 599_999); await delay(8); assert.equal(f.requests.length, 4);
  f.at(epoch + 600_000); await f.settled(5);
});

for (const recovery of ['explicit check', 'new credential']) {
  test(`authentication refusal suspends background requests until ${recovery}`, async t => {
    const f = await fixture(t);
    f.queued.push({ status: 401 });
    f.at(epoch + 30_000); await f.settled(1);
    assert.equal(f.controller.health('connection').status, 'authentication_expired');
    f.at(epoch + 3_600_000); await delay(10); assert.equal(f.requests.length, 1);
    if (recovery === 'explicit check') {
      await f.controller.check('connection');
      assert.equal(f.controller.health('connection').status, 'healthy');
      f.at(epoch + 3_900_000); await f.settled(3);
    } else {
      const previous = f.changes.at(-1)[0].adapter;
      await f.controller.connect('connection', new TextEncoder().encode('synthetic-replacement'));
      assert.notEqual(f.changes.at(-1)[0].adapter, previous);
      assert.equal(f.controller.health('connection').evidence, 'none');
      f.at(epoch + 3_629_999); await delay(8); assert.equal(f.requests.length, 1);
      f.at(epoch + 3_630_000); await f.settled(2);
    }
  });
}

test('a held probe is singleflight and disconnect cancels it before replacing connection state', async t => {
  const f = await fixture(t), release = f.hold();
  f.at(epoch + 30_000); await until(() => f.requests.length === 1, 'held probe dispatched');
  for (let n = 0; n < 10; n++) f.controller.setActivity(active);
  await delay(10); assert.equal(f.requests.length, 1);
  const disconnect = f.controller.disconnect('connection');
  await until(() => f.cancelled.includes(f.requests[0].requestId), 'disconnect cancels the active metadata request');
  release(); await disconnect;
  assert.equal(f.controller.getSnapshot().connections[0].connected, false);
  assert.equal(f.controller.getSnapshot().connections[0].health, null);
  assert.equal(f.changes.at(-1).length, 0);
  assert.equal(f.bodies.size, 0);
  f.at(epoch + 3_600_000); await delay(8); assert.equal(f.requests.length, 1);
});

test('foreground connection check cancels the automatic probe and publishes its own result', async t => {
  const f = await fixture(t), release = f.hold({ status: 401 });
  f.at(epoch + 30_000); await until(() => f.requests.length === 1, 'automatic request dispatched');
  const check = f.controller.check('connection');
  await until(() => f.cancelled.includes(f.requests[0].requestId), 'explicit check cancels automatic request');
  release(); await check;
  assert.equal(f.requests.length, 2);
  assert.equal(f.controller.health('connection').status, 'healthy');
  assert.equal(f.controller.getSnapshot().connections[0].discovery.complete, true);
  assert.equal(f.bodies.size, 0);
});

test('activity suspension cancels an in-flight probe without inventing an account refusal', async t => {
  const f = await fixture(t), release = f.hold({ status: 401 });
  const health = f.controller.health('connection');
  f.at(epoch + 30_000); await until(() => f.requests.length === 1, 'automatic request dispatched');
  f.controller.setActivity({ ...active, busy: true });
  await until(() => f.cancelled.includes(f.requests[0].requestId), 'busy cancels request');
  release(); await until(() => f.released.length === 1, 'late body released');
  assert.deepEqual(f.controller.health('connection'), health);
  f.at(epoch + 60_000); await f.settled(2);
  assert.equal(f.controller.health('connection').status, 'healthy');
});

test('dispose cancels a held probe, releases its late body and publishes no later health', async t => {
  const f = await fixture(t), release = f.hold();
  f.at(epoch + 30_000); await until(() => f.requests.length === 1, 'held probe dispatched');
  const notifications = f.notifications, changes = f.changes.length;
  const disposed = f.controller.dispose();
  await until(() => f.cancelled.includes(f.requests[0].requestId), 'dispose cancels active request');
  release(); await disposed;
  assert.equal(f.notifications, notifications);
  assert.equal(f.changes.length, changes);
  assert.equal(f.bodies.size, 0);
  assert.equal(f.controller.health('connection'), null);
  f.at(epoch + 600_000); await delay(8); assert.equal(f.requests.length, 1);
});

test('repeated completed probes release bodies and dispose does not cancel historical requests', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 12; n++) { f.at(epoch + 30_000 + n * 300_000); await f.settled(n + 1); }
  assert.equal(f.bodies.size, 0);
  assert.equal(new Set(f.released).size, 12);
  await f.controller.dispose();
  assert.deepEqual(f.cancelled, []);
});

test('a changed unavailable host capability suppresses dispatch and removes published adapters', async t => {
  const f = await fixture(t);
  f.changeTransport(value => ({ ...value, capability: { ...available, available: false, reason: 'Synthetic route unavailable' } }));
  f.at(epoch + 30_000);
  await until(() => f.capabilityReads >= 2 && !f.controller.getSnapshot().connections[0].capability.available, 'fresh host capabilities applied');
  assert.equal(f.requests.length, 0);
  assert.equal(f.changes.at(-1).length, 0, 'consumers cannot keep a stale enabled adapter');
});

test('regional eligibility is required and a changed regional configuration revokes publication before refresh', async t => {
  const f = await fixture(t, { regional: true });
  f.at(epoch + 30_000); await delay(10); assert.equal(f.requests.length, 0);
  await f.controller.setRegionalEligibility('connection', true);
  assert.equal(f.changes.at(-1).length, 1);
  f.at(epoch + 60_000); await f.settled(1);
  f.changeTransport(value => ({ ...value, regionalProcessing: { ...value.regionalProcessing, configurationId: 'changed-unreviewed-configuration' } }));
  f.at(epoch + 360_000);
  await until(() => !f.controller.getSnapshot().connections[0].regionalEligibility.confirmed, 'changed regional evidence revoked');
  assert.equal(f.requests.length, 1);
  assert.equal(f.changes.at(-1).length, 0);
});
