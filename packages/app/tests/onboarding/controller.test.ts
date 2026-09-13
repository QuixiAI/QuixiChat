/** Onboarding step 2 reports what the configured model URL actually answers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { HostClient, StorageClient } from '@quixi/core/contracts';
import { createOnboardingController, probeModelUrl } from '../../src/features/onboarding/controller.ts';
import type { ModelAvailability } from '../../src/features/onboarding/controller.ts';

const preferences = { version: 3, revision: 1, onboardingCompletedAt: null, sendKey: 'enter', interaction: { showTimestamps: true, showModelBadges: true, composerLayout: 'comfortable', modelSwitcherStyle: 'menu' }, theme: { mode: 'system', accent: 'default', presentation: 'normal' } };
const storage = {
  async request(_id: string, operation: string) {
    if (operation === 'readLocalPreferences') return preferences;
    if (operation === 'diagnostics') return { backend: 'sqlite-wasm-opfs-sahpool', ownerId: 'o', schemaVersion: 13, integrity: 'ok', databaseBytes: 1, canonicalRecords: 0, syncOperations: 0, persisted: null, usage: null, quota: null };
    if (operation === 'searchStatus') return { state: 'ready', indexedChunks: 0, semantic: { state: 'disabled', reason: null } };
    throw new Error(`Unexpected ${operation}`);
  },
} as unknown as StorageClient;
const host = { async capabilities() { return null; } } as unknown as HostClient;
const response = (status: number, type: string) => ({ ok: status >= 200 && status < 300, headers: new Headers({ 'content-type': type }) }) as Response;

test('probeModelUrl classifies a served model, a 404, an HTML fallback and a network failure', async () => {
  const seen: RequestInit[] = [];
  const at = (status: number, type: string) => (async (_url: RequestInfo | URL, init?: RequestInit) => { seen.push(init!); return response(status, type); }) as typeof fetch;
  assert.equal(await probeModelUrl('/models/m.qxmodel', at(200, 'application/octet-stream')), 'available');
  assert.equal(await probeModelUrl('/models/m.qxmodel', at(404, 'text/html')), 'missing');
  assert.equal(await probeModelUrl('/models/m.qxmodel', at(200, 'text/html; charset=utf-8')), 'missing', 'a SPA fallback document is not a model');
  assert.equal(await probeModelUrl('/models/m.qxmodel', (async () => { throw new Error('offline'); }) as typeof fetch), 'unknown');
  assert.ok(seen.every((init) => init.method === 'HEAD' && init.cache === 'no-store'));
});

test('the capability check reports the probe outcome and leaves a host without a model as missing', async () => {
  for (const [hostProvidesModel, probe, expected] of [[true, 'available', 'available'], [true, 'missing', 'missing'], [true, 'unknown', 'unknown'], [false, undefined, 'missing']] as const) {
    const controller = createOnboardingController({ storage, host, hostProvidesModel, ...(probe ? { probeModel: async () => probe as ModelAvailability } : {}) });
    await controller.refresh();
    assert.equal(controller.getSnapshot().semantic.modelAvailability, expected, `host=${hostProvidesModel} probe=${probe}`);
    assert.equal(controller.getSnapshot().semantic.hostProvidesModel, hostProvidesModel);
    await controller.dispose();
  }
  const failing = createOnboardingController({ storage, host, hostProvidesModel: true, probeModel: async () => { throw new Error('probe failed'); } });
  await failing.refresh();
  assert.equal(failing.getSnapshot().semantic.modelAvailability, 'unknown');
  await failing.dispose();
});
