import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createDesktopHost } from '../../../apps/desktop/src/host/index.ts';
import type { OAuthResult, ProviderBinding } from '@quixi/core/contracts';
type Configuration = { profile: string; phase: string; binding: ProviderBinding; allBindings: ProviderBinding[] };
type Snapshot = { pid: number; authorizations: number; tokenRequests: number; committing: boolean; oauth: { openedEvents: number; acceptedCallbacks: number; rejectedCallbacks: number; tokenExchanges: number } };
const config = (window as Window & { __QUIXI_OAUTH_PROOF__?: Configuration }).__QUIXI_OAUTH_PROOF__!;
const report: Record<string, unknown> & { success: boolean; checks: string[] } = { success: false, checks: [], scope: 'Production desktop HostClient, OAuth state machine, macOS callback plugin and OS Keychain. Native-only opener capture replaces launching an external authorization browser; callbacks are delivered to the installed unique app by LaunchServices. Synthetic endpoints and credentials only.' };
let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined, removeListener: (() => void) | undefined;
let callbackEvents = 0;
const id = () => crypto.randomUUID();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); report.checks.push(message); };
const snapshot = () => invoke<Snapshot>('oauth_proof_snapshot');
const stage = (value: string) => invoke('oauth_proof_stage', { stage: value });
async function poll<T>(label: string, read: () => Promise<T | false | null>, timeout = 12000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await wait(20); }
  throw new Error(`Timed out: ${label}`);
}
const storageSnapshot = () => JSON.stringify({ local: Object.entries(localStorage).sort(), session: Object.entries(sessionStorage).sort() });
type Outcome = { ok: true; result: OAuthResult } | { ok: false; code: string };
function start(configurationId = 'synthetic') {
  const requestId = id();
  const promise: Promise<Outcome> = host!.startOAuth({ requestId, providerId: 'oauth-fixture', configurationId, scopes: ['profile'] }).then(result => ({ ok: true as const, result }), error => ({ ok: false as const, code: typeof error?.code === 'string' ? error.code : 'unknown' }));
  return { requestId, promise };
}
async function noCredential() { check(await host!.openSecret(id(), config.binding) === null, 'No synthetic credential was persisted for the refused/cancelled flow'); }
async function consume(result: OAuthResult) {
  check(JSON.stringify(result.binding) === JSON.stringify(config.binding), 'OAuth result is bound to the exact registered synthetic destination');
  check(result.credential.persistence === 'native' && Object.keys(result.credential).sort().join(',') === 'binding,id,persistence', 'Renderer receives only an opaque native Keychain handle');
  if (config.phase === 'success') {
    const openings = (await snapshot()).authorizations;
    const existing = await start().promise;
    check(!existing.ok && (await snapshot()).authorizations === openings, 'An existing Keychain credential is refused before any authorization opener');
  }
  const response = await host!.startProviderHttp({ requestId: id(), binding: config.binding, method: 'GET', path: '/v1/models', headers: {}, credential: result.credential, bodyTransferId: null, timeout: { connectMs: 5000, idleMs: 5000, totalMs: 10000 } });
  check(response.status === 200 && response.bodyTransferId !== null, 'The native HTTP boundary used the returned Keychain credential successfully');
  if (response.bodyTransferId) {
    let bytes = 0;
    for (let index = 0; index < 8; index++) {
      const chunk = await host!.readChunk(response.bodyTransferId); bytes += chunk.bytes.length;
      await host!.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
      if (chunk.final) break;
    }
    check(bytes > 0 && bytes < 4096, 'Synthetic authenticated response is bounded');
    await host!.releaseTransfer(id(), response.bodyTransferId);
  }
  await host!.deleteSecret(id(), result.credential); await noCredential();
  report.oauthResult = result;
}
async function main() {
  check(config && /^[0-9a-f-]{36}$/.test(config.profile), 'Explicit isolated proof profile is present');
  const reloadKey = `quixi.oauth-proof.reload.${config.profile}`;
  const afterReload = config.phase === 'reload' && localStorage.getItem(reloadKey) === 'pending';
  if (afterReload) localStorage.removeItem(reloadKey);
  const beforeStorage = storageSnapshot();
  removeListener = await listen('deep-link://new-url', () => callbackEvents++);
  host = await createDesktopHost();
  check(host.secretStore.available, 'The isolated macOS Keychain service is available');
  check((await host.capabilities()).oauth.available, 'Native OAuth is available for the configured proof registration');
  if (config.phase !== 'cleanup') await noCredential();
  if (config.phase === 'cold') {
    const value = await poll('cold OS callback', async () => { const value = await snapshot(); return value.oauth.openedEvents > 0 ? value : null; });
    check(value.oauth.acceptedCallbacks === 0 && value.oauth.rejectedCallbacks > 0 && value.oauth.tokenExchanges === 0, 'Cold installed-app callback with no pending flow is refused before token HTTP');
  } else if (config.phase === 'cleanup') {
    for (const binding of config.allBindings) { const handle = await host.openSecret(id(), binding); if (handle) await host.deleteSecret(id(), handle); check(await host.openSecret(id(), binding) === null, 'Cleanup removes only this registered synthetic Keychain binding'); }
    await noCredential();
  } else if (afterReload) {
    await stage('renderer-reloaded');
    const value = await poll('old callback after reload', async () => { const value = await snapshot(); return value.oauth.openedEvents > 0 ? value : null; });
    await wait(100);
    check(value.oauth.acceptedCallbacks === 0 && value.oauth.tokenExchanges === 0, 'Renderer navigation invalidates the old pending OAuth flow before callback delivery');
    await noCredential();
  } else if (config.phase === 'overload') {
    const flows = Array.from({ length: 5 }, (_, index) => start(`overload-${index}`));
    await poll('four native authorization openings', async () => (await snapshot()).authorizations === 4);
    const overload = await Promise.race(flows.map(flow => flow.promise));
    check(!overload.ok && overload.code === 'OVERLOADED', 'Pending OAuth attempts are capped at four without queuing');
    for (const flow of flows) await host.cancel(flow.requestId);
    const results = await Promise.all(flows.map(flow => flow.promise)); check(results.every(value => !value.ok), 'All admitted pending attempts are cancelled without credentials');
    await noCredential();
  } else {
    if (config.phase === 'success') {
      for (const changed of [{ configurationId: 'unknown' }, { providerId: 'unknown' }, { scopes: ['not-allowed'] }]) {
        let rejected = false;
        try { await host.startOAuth({ requestId: id(), providerId: 'oauth-fixture', configurationId: 'synthetic', scopes: ['profile'], ...changed }); } catch { rejected = true; }
        check(rejected && (await snapshot()).authorizations === 0, 'Unknown OAuth configuration/provider/scope is refused before opening authorization');
      }
    }
    const flow = start(config.phase === 'expired' ? 'expiry' : 'synthetic');
    await poll('native opener capture', async () => (await snapshot()).authorizations === 1);
    if (config.phase === 'reload') {
      localStorage.setItem(reloadKey, 'pending'); await stage('reload-started'); location.reload(); await new Promise(() => {});
    }
    if (['cancel', 'dispose'].includes(config.phase)) {
      const staged = config.phase === 'cancel' ? await host.beginTransfer(flow.requestId, { purpose: 'file_save', expectedBytes: 1, expectedSha256: null }) : null;
      if (staged) await host.writeChunk({ transferId: staged.transferId, sequence: 0, offset: 0, final: false, bytes: new Uint8Array([42]) });
      if (config.phase === 'dispose') { await host.dispose(); host = undefined; } else await host.cancel(flow.requestId);
      if (staged) {
        let refused = false;
        try { await host!.writeChunk({ transferId: staged.transferId, sequence: 1, offset: 1, final: true, bytes: new Uint8Array() }); } catch { refused = true; }
        check(refused, 'Cancellation also removes a disk file-save stage sharing the OAuth request ID');
      }
      await stage('request-cancelled');
      await poll('callback after cancel', async () => (await snapshot()).oauth.openedEvents > 0);
      const result = await flow.promise; check(!result.ok, 'Cancelled/disposed pending OAuth never returns a credential');
      if (!host) host = await createDesktopHost();
      check((await snapshot()).oauth.tokenExchanges === 0, 'A callback after cancellation/disposal performs no token exchange'); await noCredential();
    } else if (config.phase === 'commit-cancel') {
      await poll('production credential commit guard entered', async () => (await snapshot()).committing);
      const cancelled = await host.cancel(flow.requestId);
      check(cancelled.outcome === 'unknown_outcome' && cancelled.externalEffect === 'may_have_occurred', 'Cancellation after the production COMMITTING cutoff reports unknown outcome');
      await stage('commit-cancelled');
      const result = await flow.promise; check(!result.ok && result.code === 'UNKNOWN_OUTCOME', 'The abandoned pending caller receives UNKNOWN_OUTCOME after the commit cutoff');
      await host.dispose(); host = await createDesktopHost();
      const credential = await poll('reconcile actual committed Keychain value in new session', () => host!.openSecret(id(), config.binding));
      await consume({ requestId: flow.requestId, binding: config.binding, credential });
      report.commitCancellation = cancelled;
    } else if (config.phase === 'cancel-token') {
      await poll('actual token HTTP began', async () => (await snapshot()).tokenRequests === 1);
      const cancelled = await host.cancel(flow.requestId);
      check(cancelled.outcome === 'cancelled', 'Explicit cancellation stops the active held token exchange before the commit cutoff');
      report.tokenCancellation = cancelled;
      await stage('token-cancelled');
      const result = await flow.promise; check(!result.ok, 'Cancellation during held token exchange rejects the pending result');
      await wait(350); await noCredential();
    } else if (['bad-state', 'bad-issuer', 'bad-path', 'duplicate-query'].includes(config.phase)) {
      await poll('OS rejected callback', async () => (await snapshot()).oauth.rejectedCallbacks > 0);
      check((await snapshot()).oauth.tokenExchanges === 0, 'Malformed or mismatched callback causes zero token HTTP');
      report.refusedCallbackSnapshot = await snapshot(); await stage('bad-callback-rejected');
      const result = await flow.promise; check(result.ok, 'A rejected callback leaves its legitimate pending flow usable');
      if (!result.ok) throw new Error(`Legitimate pending flow failed after a bad callback: ${result.code}`);
      await consume(result.result);
    } else {
      const result = await flow.promise;
      if (['success', 'duplicate-callback', 'auxiliary-tokens'].includes(config.phase)) {
        check(result.ok, 'Actual installed warm callback completes native authorization-code flow');
        if (!result.ok) throw new Error(`OAuth unexpectedly failed: ${result.code}`);
        await consume(result.result);
        if (config.phase === 'duplicate-callback') { const value = await poll('second OS callback delivery', async () => { const value = await snapshot(); return value.oauth.openedEvents >= 2 ? value : null; }); check(value.oauth.tokenExchanges === 1 && value.oauth.rejectedCallbacks >= 1, 'Duplicate callback cannot exchange the code twice'); }
      } else {
        check(!result.ok, 'Denial, expiry or invalid/bounded token response yields no credential');
        if (!result.ok) report.failureCode = result.code;
        if (config.phase === 'denied') {
          const value = await snapshot();
          check(!result.ok && result.code === 'IO_ERROR' && value.oauth.acceptedCallbacks === 1 && value.oauth.openedEvents >= 1 && value.oauth.tokenExchanges === 0, 'Correlated issuer-verified denial consumes the flow immediately without token HTTP');
        }
        if (config.phase === 'expired') await poll('expired callback delivered', async () => (await snapshot()).oauth.openedEvents > 0);
        await noCredential();
      }
    }
  }
  check(callbackEvents === 0, 'Raw OS callback URLs were not emitted to the renderer');
  check(storageSnapshot() === beforeStorage, 'OAuth leaves renderer localStorage and sessionStorage unchanged');
  report.snapshot = await snapshot(); report.rendererCallbackEvents = callbackEvents;
}
try { await main(); report.success = true; }
catch (error) { report.error = { message: String(error), stack: (error as Error)?.stack }; }
finally {
  removeListener?.();
  try { await host?.dispose(); } catch { report.success = false; report.disposeFailed = true; }
  document.getElementById('result')!.textContent = JSON.stringify(report, null, 2);
  await invoke('oauth_proof_report', { report: JSON.stringify(report), success: report.success });
}
