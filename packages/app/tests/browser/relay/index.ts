import { mountApp } from '@quixi/app';
import type { EntityPage } from '@quixi/core/contracts';
import type { JsonObject, ThreadState } from '@quixi/core/model';
import { createIsolatedStorageClient } from '../../../../storage/tests/isolated-client.ts';
import { createWebHost } from '../../../../../apps/web/src/host/index.ts';
import { configuredWebProviders } from '../../../../../apps/web/src/configuration.ts';
const query = new URL(location.href).searchParams;
const archiveId = query.get('archive')!;
const fixture = await fetch(`/fixture-configuration?case=${encodeURIComponent(query.get('case') ?? 'good')}`).then(response => response.json());
const configuration = configuredWebProviders(JSON.stringify(fixture));
const host = createWebHost({ destinations: configuration.destinations, fileStagingNamespace: archiveId });
const storage = createIsolatedStorageClient({ archiveId });
const unmount = mountApp(document.getElementById('app')!, {
  archiveId, storage, host, startupNotice: configuration.notice,
  temporaryDownloads: { list: host.listTemporaryDownloads, clear: id => host.clearTemporaryDownload(crypto.randomUUID(), id) },
  providerSettings: { connections: configuration.connections, credentialCapability: { available: true, permission: 'not_required', reason: null }, setRelayAuthorization: host.setRelayAuthorization },
});
Object.assign(window, { regionalRelayAcceptance: {
  async records(collection: 'messages'|'generations'|'threadStates'|'summaryProposals'|'events') {
    const items: unknown[] = []; let cursor: string | null = null;
    for (let index = 0; index < 8; index++) {
      const page: EntityPage = await storage.request(crypto.randomUUID(), 'readEntities', { collection, threadId: null, page: { maxItems: 64, maxBytes: 900000, cursor } });
      items.push(...page.items); cursor = page.nextCursor; if (!cursor) return items;
    }
    throw new Error('Regional relay fixture exceeded its bounded record read.');
  },
  capabilities: () => host.capabilities(),
  async setStoredProcessingRegion(region: 'us' | 'eu') {
    const page = await storage.request(crypto.randomUUID(), 'readEntities', { collection: 'threadStates', threadId: null, page: { maxItems: 2, maxBytes: 900000, cursor: null } });
    if (page.items.length !== 1) throw new Error('The race fixture requires exactly one conversation.');
    const state = page.items[0] as unknown as ThreadState;
    const value = structuredClone(state.routingProfile) as JsonObject;
    value.requirements = { ...(value.requirements as JsonObject), processingRegion: region };
    await storage.request(crypto.randomUUID(), 'commit', {
      transactionId: crypto.randomUUID(), expectedThreadRevisions: [{ threadId: state.threadId, revision: state.revision }], stagedBlobIds: [],
      mutations: [{ version: 1, operationId: crypto.randomUUID(), kind: 'SetRoutingProfile', recordedAt: Date.now(), payload: { threadId: state.threadId, value } }],
    });
  },
  async mutateReturnedCapabilities() {
    const caps = await host.capabilities(), transport = caps.providerTransports.find(value => value.regionalProcessing?.relay);
    if (!transport?.regionalProcessing?.relay) throw new Error('No admitted regional relay capability.');
    transport.endpointOrigin = 'https://unregistered.invalid';
    transport.regionalProcessing.relay.origin = 'https://unregistered.invalid';
    transport.regionalProcessing.relay.configurationId = '0'.repeat(64);
    transport.regionalProcessing.upstreamOrigin = 'https://eu.api.openai.com';
  },
  async close() { await unmount(); await storage.close(); await host.dispose(); },
} });
