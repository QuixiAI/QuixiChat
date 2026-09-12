import { createWebHost, type WebHostConfig } from '../src/host/index.ts';
import type { OAuthResult, ProviderBinding, SecretHandle } from '@quixi/core/contracts';
let host: ReturnType<typeof createWebHost>, result: OAuthResult | null = null, manual: SecretHandle | null = null;
let requestId = '', outcome: null | { ok: boolean; code?: string; keys?: string[]; persistence?: string } = null;
let binding: ProviderBinding, run = '';
let originalBroadcast: typeof BroadcastChannel | undefined, lastCancellation: unknown;
let nextConfiguration = 'synthetic';
const lifecycle = { hidden: 0, restoredFromCache: 0 };
window.addEventListener('pagehide', () => { lifecycle.hidden++; });
window.addEventListener('pageshow', event => { if (event.persisted) lifecycle.restoredFromCache++; });
const status = () => { document.getElementById('status')!.textContent = JSON.stringify({ outcome, lastCancellation }); };
const id = () => crypto.randomUUID();
const proof = {
  async setup(value: { run: string; mode?: string; empty?: boolean; timeoutMs?: number; unavailableChannel?: boolean; multiple?: boolean }) {
    if (host) await host.dispose();
    if (originalBroadcast) Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: originalBroadcast });
    run = value.run; result = null; manual = null; outcome = null; lastCancellation = null; nextConfiguration = 'synthetic';
    binding = { providerId: 'oauth-fixture', accountId: 'primary', destinationId: 'synthetic-api', transportId: 'synthetic-web' };
    if (value.unavailableChannel) { originalBroadcast = window.BroadcastChannel; Object.defineProperty(window, 'BroadcastChannel', { configurable: true, value: undefined }); }
    const auth = 'http://127.0.0.1:4217', mode = value.mode ?? 'success';
    const config: WebHostConfig = { destinations: [{ binding, baseUrl: auth, allowInsecureLoopback: true, routes: [{ path: '/resource/' + run, methods: ['GET'], headers: [] }], credential: { header: 'Authorization', prefix: 'Bearer ' }, transport: { kind: 'browser_direct', privacy: 'local', relayIdentity: null } }], fileStagingNamespace: 'oauth-' + run, oauthConfigurations: value.empty ? [] : [{ id: 'synthetic', binding, authorizationEndpoint: `${auth}/authorize/${run}/${mode}`, tokenEndpoint: `${auth}/token/${run}/${mode}`, redirectUri: location.origin + '/oauth/callback.html', issuer: auth, clientId: 'quixi-web-oauth-proof', allowedScopes: ['profile'], timeoutMs: value.timeoutMs ?? 15000, allowInsecureLoopback: true }] };
    if (value.multiple) for (let index = 1; index < 5; index++) {
      const extra = { ...binding, accountId: `account-${index}`, destinationId: `synthetic-api-${index}`, transportId: `synthetic-web-${index}` };
      config.destinations.push({ ...config.destinations[0]!, binding: extra });
      config.oauthConfigurations!.push({ ...config.oauthConfigurations![0]!, id: `synthetic-${index}`, binding: extra });
    }
    host = createWebHost(config); status();
  },
  start(changes: Record<string, unknown> = {}) {
    requestId = id(); outcome = null;
    void host.startOAuth({ requestId, providerId: 'oauth-fixture', configurationId: 'synthetic', scopes: ['profile'], ...changes }).then(value => { result = value; outcome = { ok: true, keys: Object.keys(value.credential).sort(), persistence: value.credential.persistence }; status(); }, error => { outcome = { ok: false, code: String(error?.code ?? 'unknown') }; status(); });
  },
  snapshot: () => ({ outcome, lastCancellation, requestId, isolated: crossOriginIsolated, secure: isSecureContext, lifecycle }),
  capabilities: () => host.capabilities(),
  nextConfiguration(value: string) { nextConfiguration = value; },
  async cancel() { lastCancellation = await host.cancel(requestId); status(); },
  dispose: () => host.dispose(),
  async hasCredential() { return await host.openSecret(id(), binding) !== null; },
  async manualKey() { manual = await host.storeSecret(id(), binding, new TextEncoder().encode('synthetic-manual-secret'), null); },
  async consume(useManual = false) {
    const credential = useManual ? manual : result?.credential;
    if (!credential) throw new Error('Expected an opaque credential');
    const response = await host.startProviderHttp({ requestId: id(), binding, credential, method: 'GET', path: '/resource/' + run, headers: {}, bodyTransferId: null, timeout: { connectMs: 3000, idleMs: 3000, totalMs: 6000 } });
    if (response.bodyTransferId) { for (let index = 0; index < 8; index++) { const chunk = await host.readChunk(response.bodyTransferId); await host.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length }); if (chunk.final) break; } await host.releaseTransfer(id(), response.bodyTransferId); }
    return response.status;
  },
  async clearCredential() { const current = await host.openSecret(id(), binding); if (current) await host.deleteSecret(id(), current); },
};
(window as unknown as { oauthProof: typeof proof }).oauthProof = proof;
document.getElementById('connect')!.onclick = () => proof.start({ configurationId: nextConfiguration });
