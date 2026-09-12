import { browserEngines } from "../../../tooling/browser-engines.mjs";
const selectedEngines = browserEngines({ chromium, webkit });
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, origin, token } from './fixture.mjs';
const vite = await createServer({ root: fileURLToPath(new URL('../../web', import.meta.url)), configFile: false, server: { host: '127.0.0.1', port: 4197, strictPort: true } });
await vite.listen();
const results = [];
try {
  for (const [name, browserType] of selectedEngines) {
    const f = await fixture(); const browser = await browserType.launch();
    try {
      const page = await browser.newPage(); await page.goto(`${origin}/tests/host.html`);
      const result = await page.evaluate(async ({ relayOrigin, token }) => {
        const { createWebHost } = await import('/src/host/index.ts');
        const binding = { providerId: 'fixture', accountId: 'synthetic', destinationId: 'relay-fixture', transportId: 'relay' };
        const host = createWebHost({ destinations: [{ binding, baseUrl: relayOrigin, allowInsecureLoopback: true, routes: ['/echo', '/stream', '/error'].map(path => ({ path, methods: ['GET', 'POST'], headers: ['content-type'] })), credential: { header: 'x-api-key', prefix: '' }, transport: { kind: 'relay', privacy: 'self_hosted_remote', relayIdentity: 'synthetic test operator' }, relayDestinationId: 'fixture' }] });
        await host.setRelayAuthorization(binding.destinationId, new TextEncoder().encode(token));
        const credential = await host.storeSecret(crypto.randomUUID(), binding, new TextEncoder().encode('synthetic-provider-secret'), null);
        const body = new TextEncoder().encode('synthetic browser raw body');
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(n => n.toString(16).padStart(2, '0')).join('');
        const stage = await host.beginTransfer(crypto.randomUUID(), { purpose: 'provider_request', expectedBytes: body.length, expectedSha256: sha256 });
        await host.writeChunk({ transferId: stage.transferId, sequence: 0, offset: 0, bytes: body, final: true });
        await host.finishTransfer(crypto.randomUUID(), stage.transferId, { byteLength: body.length, sha256 });
        const request = path => ({ requestId: crypto.randomUUID(), binding, method: 'POST', path, headers: { 'content-type': 'text/plain' }, credential, bodyTransferId: stage.transferId, timeout: { connectMs: 5000, idleMs: 5000, totalMs: 10000 } });
        const response = await host.startProviderHttp(request('/error')); let text = '';
        for (;;) { const chunk = await host.readChunk(response.bodyTransferId); text += new TextDecoder().decode(chunk.bytes); await host.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length }); if (chunk.final) break; }
        const streamRequest = request('/stream'); const streamed = await host.startProviderHttp(streamRequest);
        const chunk = await host.readChunk(streamed.bodyTransferId); const first = new TextDecoder().decode(chunk.bytes);
        const cancelled = await host.cancel(streamRequest.requestId);
        await host.releaseTransfer(crypto.randomUUID(), stage.transferId); await host.dispose();
        return { status: response.status, headers: response.headers, text, first, cancelled, persisted: [localStorage.length, sessionStorage.length] };
      }, { relayOrigin: f.relayOrigin, token });
      assert.equal(result.status, 429); assert.equal(result.text, 'synthetic browser raw body'); assert.equal(result.headers['retry-after'], '3'); assert.match(result.first, /first/); assert.equal(result.cancelled.externalEffect, 'may_have_occurred'); assert.deepEqual(result.persisted, [0, 0]);
      await delay(100); assert.ok(f.disconnected() >= 1); assert.equal(f.relay.stats().active, 0);
      assert.equal(f.received.length, 2); assert.ok(f.received.every(r => r.headers['x-api-key'] === 'synthetic-provider-secret' && !r.headers.authorization && !r.headers.cookie));
      results.push({ browser: name, version: browser.version(), status: 'passed', checks: ['cross-origin preflight', 'real HostClient staged raw body', 'upstream error metadata', 'incremental response', 'cancel disconnect', 'bound credential injection', 'no browser persistence'] });
    } finally { await browser.close(); await f.close(); }
  }
  console.log(JSON.stringify({ node: process.version, selectedEngines: selectedEngines.map(([name]) => name), results }, null, 2));
} finally { await vite.close(); }
