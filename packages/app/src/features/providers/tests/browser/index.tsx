import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWebHost } from '../../../../../../../apps/web/src/host/index.ts';
import { initialProviderCatalogs, openAIRegionalEvidence, type ProviderAdapter, type ProviderInput } from '@quixi/providers';
import type { HostClient, ProviderBinding } from '@quixi/core/contracts';
import { ProviderSettingsPanel, createProviderSettingsController, type ConfiguredConnection, type ProviderConnection } from '../../index.ts';
const origin = new URL(location.href).searchParams.get('fixture')!;
const catalogs = initialProviderCatalogs();
const connections: ProviderConnection[] = catalogs.map(catalog => ({ id: catalog.providerId, label: catalog.providerId === 'openai' ? 'OpenAI' : 'Anthropic', catalog, relayAuthorizationRequired: false, binding: { providerId: catalog.providerId, accountId: 'primary', destinationId: catalog.providerId, transportId: catalog.providerId } }));
for (const region of ['us', 'eu'] as const) connections.push({ id: `openai-${region}`, label: region === 'us' ? 'OpenAI · US' : 'OpenAI · Europe (EEA + Switzerland)', catalog: catalogs.find(catalog => catalog.providerId === 'openai')!, relayAuthorizationRequired: false, processingRegion: region, binding: openAIRegionalEvidence(region).binding });
const wireHost = createWebHost({ destinations: connections.map(connection => ({ binding: connection.binding, baseUrl: origin, allowInsecureLoopback: true, transport: { kind: 'browser_direct', privacy: 'local', relayIdentity: null }, credential: { header: connection.catalog.providerId === 'openai' ? 'Authorization' : 'x-api-key', prefix: connection.catalog.providerId === 'openai' ? 'Bearer ' : '' }, routes: [{ path: '/v1/models', methods: ['GET'], headers: ['anthropic-version'], ...(connection.id === 'anthropic' ? { query: ['after_id', 'before_id', 'limit'] } : {}) }, { path: connection.catalog.providerId === 'openai' ? '/v1/chat/completions' : '/v1/messages', methods: ['POST'], headers: ['content-type', 'anthropic-version'] }, ...(connection.id === 'anthropic' ? [{ path: '/v1/messages/count_tokens', methods: ['POST' as const], headers: ['content-type', 'anthropic-version'] }] : [])] })) });
const boundary: { binding: ProviderBinding; path: string; method: string }[] = [];
const invalidMetadata = new Set<string>();
/** Explicit test-only native declarations. Actual wire traffic stays in the
 * unchanged production WebHost on loopback. This is UI/controller evidence,
 * not evidence that a browser supplies a regional native transport. */
const host: HostClient = { ...wireHost, async capabilities() {
  const caps = await wireHost.capabilities();
  return { ...caps, providerTransports: caps.providerTransports.map(transport => {
    const connection = connections.find(item => item.binding.transportId === transport.id)!;
    if (!connection.processingRegion) return transport;
    const evidence = openAIRegionalEvidence(connection.processingRegion);
    if (invalidMetadata.has(connection.id)) evidence.binding.accountId = 'wrong-account';
    return { ...transport, kind: 'native_direct', privacy: 'direct_provider', endpointOrigin: evidence.upstreamOrigin, regionalProcessing: evidence };
  }) };
}, startProviderHttp(request, beforeDispatch) { boundary.push({ binding: structuredClone(request.binding), path: request.path, method: request.method }); return wireHost.startProviderHttp(request, beforeDispatch); } };
let configured: readonly ConfiguredConnection[] = [];
const retained = new Map<string, ProviderAdapter>();
const controller = createProviderSettingsController({ host, connections, credentialCapability: { available: true, permission: 'not_required', reason: null }, onChange: value => { configured = value; } });
const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode><p role="note">Synthetic browser proof: regional native capability declarations are injected; all HTTP requests use a local fixture. This does not verify geography or provider account eligibility.</p><ProviderSettingsPanel controller={controller} /></StrictMode>);
const input = (modelId: string, image = false): ProviderInput => {
  const messageId = crypto.randomUUID(), attachmentId = crypto.randomUUID();
  return { requestId: crypto.randomUUID(), modelId, systemPrompt: 'Synthetic system', messages: [{ role: 'user', parts: [{ id: crypto.randomUUID(), messageId, order: 0, kind: 'Text', data: { text: 'Synthetic text' } }, ...(image ? [{ id: crypto.randomUUID(), messageId, order: 1, kind: 'Image' as const, data: { attachmentId, description: null } }] : [])] }], parameters: { maxOutputTokens: 100 }, ...(image ? { attachments: { [attachmentId]: { mediaType: 'image/png', bytes: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5x8AAAAASUVORK5CYII='), character => character.charCodeAt(0)) } } } : {}) };
};
Object.assign(window, { providerSetup: {
  async stream(id: string, image = false) {
    const entry = configured.find(value => value.id === id); if (!entry) throw new Error('Connection is not published.');
    const operation = entry.adapter.stream(input(entry.models[0]!.id, image)); let text = '', terminal = '';
    for await (const event of operation.events) { if (event.type === 'text') text += event.text; if (event.type === 'terminal') terminal = event.status; }
    return { text, terminal };
  },
  count: () => configured.length,
  ids: () => configured.map(entry => entry.id),
  model: (id: string) => configured.find(entry => entry.id === id)?.models[0] ?? null,
  boundary: () => structuredClone(boundary),
  capture(id: string) { retained.set(id, configured.find(entry => entry.id === id)!.adapter); },
  async rejectedImage(id: string) { try { configured.find(entry => entry.id === id)!.adapter.prepare(input('gpt-4.1-mini-2025-04-14', true)); return false; } catch { return true; } },
  async retainedRefusals(id: string) {
    const adapter = retained.get(id)!; const results: Record<string, boolean> = {};
    for (const method of ['prepare', 'countTokens', 'stream'] as const) {
      try { await adapter[method](input('gpt-4.1-mini-2025-04-14')); results[method] = false; } catch { results[method] = true; }
    }
    return results;
  },
  setInvalidMetadata(id: string, invalid: boolean) { if (invalid) invalidMetadata.add(id); else invalidMetadata.delete(id); },
  async reopen(id: string) { return host.openSecret(crypto.randomUUID(), connections.find(value => value.id === id)!.binding); },
  async close() { root.unmount(); await controller.dispose(); await wireHost.dispose(); },
} });
