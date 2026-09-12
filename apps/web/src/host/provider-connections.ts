import { initialProviderCatalogs, openAIRelayRegionalEvidence } from '@quixi/providers';
import type { PrivacyClass } from '@quixi/core/contracts';
import type { ProviderConnection } from '@quixi/app/features/providers';
import type { WebDestination } from './index.ts';
export interface ReviewedRelayConfiguration {
  origin: string; operator: string; privacy: Extract<PrivacyClass, 'quixi_relay' | 'self_hosted_remote' | 'custom_remote'>;
  destinations: { openai: string; anthropic: string };
  regional?: { region: 'us' | 'eu'; destinationId: string; configurationId: string;
    /** Separate regional relays may have their own reviewed origin/operator. */
    origin?: string; operator?: string; privacy?: ReviewedRelayConfiguration['privacy'] }[];
}
const exactKeys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
/** Called by trusted composition with operator configuration, never arbitrary request/UI URLs. */
export function webProviderConnections(relay: ReviewedRelayConfiguration | null): { connections: ProviderConnection[]; destinations: WebDestination[] } {
  if (relay) {
    const url = new URL(relay.origin);
    if (!exactKeys(relay, ['origin', 'operator', 'privacy', 'destinations', 'regional']) || url.protocol !== 'https:' || url.origin !== relay.origin ||
      !relay.operator.trim() || relay.operator.trim() !== relay.operator || relay.operator.length > 256 ||
      !['quixi_relay', 'self_hosted_remote', 'custom_remote'].includes(relay.privacy) ||
      !relay.destinations || !exactKeys(relay.destinations, ['openai', 'anthropic']) ||
      [relay.destinations.openai, relay.destinations.anthropic].some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)))
      throw new Error('Invalid reviewed relay configuration.');
    if (relay.regional !== undefined && (!Array.isArray(relay.regional) || relay.regional.length > 2 || new Set(relay.regional.map(value => value?.region)).size !== relay.regional.length))
      throw new Error('Invalid regional relay configuration.');
    for (const value of relay.regional ?? []) if (!value || !exactKeys(value, ['region', 'destinationId', 'configurationId', 'origin', 'operator', 'privacy']) ||
      !['us', 'eu'].includes(value.region) || !/^[A-Za-z0-9_-]{1,80}$/.test(value.destinationId) || !/^[a-f0-9]{64}$/.test(value.configurationId) ||
      [value.origin, value.operator, value.privacy].some(item => item !== undefined && typeof item !== 'string') ||
      ((value.origin ?? relay.origin) === relay.origin && Object.values(relay.destinations).includes(value.destinationId))) throw new Error('Invalid regional relay configuration.');
    if (new Set((relay.regional ?? []).map(value => JSON.stringify([value.origin ?? relay.origin, value.destinationId]))).size !== (relay.regional ?? []).length) throw new Error('Duplicate regional relay destination.');
  }
  const catalogs = initialProviderCatalogs();
  const connections: ProviderConnection[] = catalogs.map(catalog => ({
    id: catalog.providerId, label: catalog.providerId === 'openai' ? 'OpenAI' : 'Anthropic', catalog, relayAuthorizationRequired: !!relay,
    binding: { providerId: catalog.providerId, accountId: 'primary', destinationId: `quixi-${catalog.providerId}-relay-v1`, transportId: `quixi-${catalog.providerId}-relay-v1` },
  }));
  const destinations: WebDestination[] = relay ? connections.map(connection => ({
    binding: connection.binding, baseUrl: relay.origin, relayDestinationId: relay.destinations[connection.catalog.providerId],
    transport: { kind: 'relay', privacy: relay.privacy, relayIdentity: relay.operator },
    credential: { header: connection.catalog.providerId === 'openai' ? 'Authorization' : 'x-api-key', prefix: connection.catalog.providerId === 'openai' ? 'Bearer ' : '' },
    routes: [
      { path: '/v1/models', methods: ['GET'], headers: connection.catalog.providerId === 'anthropic' ? ['anthropic-version'] : [], ...(connection.catalog.providerId === 'anthropic' ? { query: ['after_id', 'before_id', 'limit'] } : {}) },
      { path: connection.catalog.providerId === 'anthropic' ? '/v1/messages' : '/v1/chat/completions', methods: ['POST'], headers: connection.catalog.providerId === 'anthropic' ? ['content-type', 'anthropic-version'] : ['content-type'] },
      ...(connection.catalog.providerId === 'anthropic' ? [{ path: '/v1/messages/count_tokens', methods: ['POST' as const], headers: ['content-type', 'anthropic-version'] }] : []),
    ],
  })) : [];
  for (const value of relay?.regional ?? []) {
    const origin = value.origin ?? relay!.origin, operator = value.operator ?? relay!.operator, privacy = value.privacy ?? relay!.privacy;
    if (new URL(origin).protocol !== 'https:' || !['quixi_relay', 'self_hosted_remote', 'custom_remote'].includes(privacy)) throw new Error('Invalid regional relay origin or privacy class.');
    const regionalProcessing = openAIRelayRegionalEvidence(value.region, { region: value.region, destinationId: value.destinationId, configurationId: value.configurationId, origin, operator });
    connections.push({ id: `openai-${value.region}-relay`, label: `OpenAI · ${value.region === 'us' ? 'US' : 'Europe'} relay`, catalog: catalogs.find(value => value.providerId === 'openai')!, relayAuthorizationRequired: true, processingRegion: value.region, binding: regionalProcessing.binding });
    destinations.push({ binding: regionalProcessing.binding, baseUrl: origin, relayDestinationId: value.destinationId,
      transport: { kind: 'relay', privacy, relayIdentity: operator, regionalProcessing },
      credential: { header: 'Authorization', prefix: 'Bearer ' },
      routes: [{ path: '/v1/models', methods: ['GET'], headers: [] }, { path: '/v1/chat/completions', methods: ['POST'], headers: ['content-type'] }],
    });
  }
  return { connections, destinations };
}
