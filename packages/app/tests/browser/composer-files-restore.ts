import { mountApp } from '@quixi/app';
import { sameArchiveSelection, type ArchiveSelection, type EntityPage } from '@quixi/core/contracts';
import { openActiveStorageClient, archiveActivationStatus, reconcilePreviousArchiveOperations, reconcilePreviousArchiveExtraction } from '@quixi/storage/client';
import { initialProviderCatalogs } from '@quixi/providers';
import { createWebHost } from '../../../../apps/web/src/host/index.ts';
import { attachmentFingerprint } from './composer-files-storage.ts';

// This entry is served only by the disposable localhost browser proof. It uses
// the real managed selection/restore composition, separately from test-* history.
if (location.hostname !== '127.0.0.1' || location.port !== '4197') throw new Error('Composer restore fixture requires its isolated loopback origin');
const connections = initialProviderCatalogs().map(catalog => ({ id: catalog.providerId, label: catalog.providerId === 'openai' ? 'OpenAI' : 'Anthropic', catalog, relayAuthorizationRequired: false, binding: { providerId: catalog.providerId, accountId: 'primary', destinationId: catalog.providerId, transportId: catalog.providerId } }));
const host = createWebHost({ destinations: connections.map(connection => ({ binding: connection.binding, baseUrl: location.origin, allowInsecureLoopback: true, transport: { kind: 'browser_direct', privacy: 'local', relayIdentity: null }, credential: { header: connection.id === 'openai' ? 'Authorization' : 'x-api-key', prefix: connection.id === 'openai' ? 'Bearer ' : '' }, routes: [
  { path: '/v1/models', methods: ['GET'], headers: ['anthropic-version'] },
  { path: connection.id === 'openai' ? '/v1/chat/completions' : '/v1/messages', methods: ['POST'], headers: ['content-type', 'anthropic-version'] },
  ...(connection.id === 'anthropic' ? [{ path: '/v1/messages/count_tokens', methods: ['POST' as const], headers: ['content-type', 'anthropic-version'] }] : []),
] })) });
let storage: Awaited<ReturnType<typeof openActiveStorageClient>>;
let unmount: (() => Promise<void>) | undefined;
let opening = false;
// Test-only metadata ring: no request payloads, document bytes, or credentials.
const requestEvents: Array<Record<string, string | number | null>> = [];
function record(event: Record<string, string | number | null>) {
  requestEvents.push({ at: Math.round(performance.now()), ...event });
  if (requestEvents.length > 128) requestEvents.shift();
}
function observeRequests(client: typeof storage): typeof storage {
  return new Proxy(client, { get(target, property, receiver) {
    if (property === 'request') return async (...args: Parameters<typeof client.request>) => {
      const [requestId, operation, payload] = args;
      const threadId = payload && typeof payload === 'object' && 'threadId' in payload && typeof payload.threadId === 'string' ? payload.threadId : null;
      record({ event: 'start', requestId, operation, threadId });
      try {
        const result = await Reflect.apply(target.request, target, args);
        record({ event: 'end', requestId, operation, threadId });
        return result;
      } catch (error) {
        record({ event: 'error', requestId, operation, threadId, error: String(error).slice(0, 256) });
        throw error;
      }
    };
    if (property === 'onChange') return (listener: (operationIds: string[]) => void) => target.onChange(ids => {
      record({ event: 'change', operationCount: ids.length });
      listener(ids);
    });
    return Reflect.get(target, property, receiver);
  } });
}
async function openSelectedArchive(expected?: ArchiveSelection) {
  if (opening) return;
  opening = true;
  let next: typeof storage | undefined;
  try {
    next = observeRequests(await openActiveStorageClient());
    if (expected && !sameArchiveSelection(next.selection, expected)) throw new Error('Restored selection changed');
    await unmount?.(); await storage?.close(); storage = next; next = undefined;
    const selected = storage;
    unmount = mountApp(document.getElementById('app')!, {
      archiveId: selected.archiveId, storage: selected, host,
      archiveSession: { selection: selected.selection, activationStatus: archiveActivationStatus, reconcilePreviousOperations: ids => reconcilePreviousArchiveOperations(selected, ids), reconcilePreviousExtractionOperation: pending => reconcilePreviousArchiveExtraction(selected, pending), onSelectionChange: listener => selected.onSelectionChange(listener), openSelectedArchive },
      providerSettings: { connections, credentialCapability: { available: true, permission: 'not_required', reason: null } },
      temporaryDownloads: { list: host.listTemporaryDownloads, clear: transferId => host.clearTemporaryDownload(crypto.randomUUID(), transferId) },
    });
  } finally { await next?.close(); opening = false; }
}
Object.assign(window, { composerRestoreProof: {
  fingerprint: (sha256: string) => attachmentFingerprint(storage, sha256),
  entity: (collection: 'attachments' | 'messages' | 'parts' | 'threadStates', id: string) => storage.request(crypto.randomUUID(), 'readEntity', { collection, id }),
  parts: (messageId: string): Promise<EntityPage> => storage.request(crypto.randomUUID(), 'readMessageParts', { messageId, page: { maxItems: 32, maxBytes: 65536, cursor: null } }),
  selection: () => structuredClone(storage.selection),
  diagnostics: () => ({ opening, selection: structuredClone(storage.selection), requestEvents: structuredClone(requestEvents) }),
  async close() { await unmount?.(); await storage?.close(); await host.dispose(); },
} });
await openSelectedArchive();
