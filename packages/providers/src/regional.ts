import type { ProviderBinding, ProviderTransport, RegionalProcessingEvidence } from '@quixi/core/contracts';

export const regionalLabel = (region: 'us' | 'eu') => region === 'us' ? 'United States' : 'Europe (EEA + Switzerland)';
/** Dated provider facts combined with the separately enforced native registry.
 * This declaration does not establish account eligibility or physical location. */
export function openAIRegionalEvidence(region: 'us' | 'eu'): RegionalProcessingEvidence {
  if (region !== 'us' && region !== 'eu') throw new Error('Unsupported processing region.');
  return {
    version: 1,
    configurationId: `openai-${region}-gpt41-mini-2026-09-10`,
    binding: { providerId: 'openai', accountId: 'primary', destinationId: `quixi-openai-${region}-api-v1`, transportId: `quixi-openai-${region}-native-v1` },
    region, upstreamOrigin: `https://${region}.api.openai.com`,
    modelIds: ['gpt-4.1-mini-2025-04-14'], endpoints: ['/v1/chat/completions'], inputModalities: ['text', 'image'],
    sourceUrl: 'https://developers.openai.com/api/docs/guides/your-data', reviewedAt: Date.parse('2026-09-10T00:00:00Z'),
  };
}
type Relay = NonNullable<RegionalProcessingEvidence['relay']>;
function assertRelay(value: Relay): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5 || Object.keys(value).some(key => !['configurationId', 'operator', 'origin', 'region', 'destinationId'].includes(key))) throw new Error('Invalid regional relay declaration.');
  if (typeof value.configurationId !== 'string' || !/^[0-9a-f]{64}$/.test(value.configurationId) || typeof value.operator !== 'string' || value.operator.trim() !== value.operator || !value.operator.length || value.operator.length > 256 || /[\u0000-\u001f\u007f]/.test(value.operator) || (value.region !== 'us' && value.region !== 'eu') || typeof value.destinationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.destinationId)) throw new Error('Invalid regional relay declaration.');
  let origin: URL;
  try { origin = new URL(value.origin); } catch { throw new Error('Invalid regional relay origin.'); }
  if (typeof value.origin !== 'string' || origin.origin !== value.origin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error('Regional relay origin must be HTTPS or exact HTTP loopback.');
}
/** Provider facts plus a host-admitted relay configuration. The browser host
 * must establish the operator declaration before admitting this evidence. */
export function openAIRelayRegionalEvidence(region: 'us' | 'eu', relay: Relay): RegionalProcessingEvidence {
  assertRelay(relay);
  if (relay.region !== region) throw new Error('Relay and upstream processing regions must match.');
  const upstream = openAIRegionalEvidence(region);
  return { ...upstream, configurationId: `${upstream.configurationId}-${relay.configurationId}`,
    binding: { providerId: 'openai', accountId: 'primary', destinationId: `quixi-openai-${region}-relay-v1`, transportId: `quixi-openai-${region}-relay-v1` }, relay: { ...relay } };
}
const bindingMatches = (actual: ProviderBinding | undefined, expected: ProviderBinding) =>
  !!actual && Object.keys(actual).length === 4 && (Object.keys(expected) as (keyof ProviderBinding)[]).every(key => actual[key] === expected[key]);
/** Match reviewed upstream facts and a host-admitted native or relay route.
 * This validator checks metadata; the host separately admits relay declarations. */
export function reviewedRegionalTransport(region: 'us' | 'eu', binding: ProviderBinding, transport: ProviderTransport | undefined): RegionalProcessingEvidence | null {
  const value = transport?.regionalProcessing;
  if (!transport || !value) return null;
  let expected: RegionalProcessingEvidence;
  try { expected = value.relay !== undefined ? openAIRelayRegionalEvidence(region, value.relay) : openAIRegionalEvidence(region); } catch { return null; }
  if (expected.relay) {
    if (transport.kind !== 'relay' || !['quixi_relay', 'self_hosted_remote', 'custom_remote'].includes(transport.privacy) || transport.relayIdentity !== expected.relay.operator || transport.endpointOrigin !== expected.relay.origin) return null;
  } else if (transport.kind !== 'native_direct' || transport.privacy !== 'direct_provider' || transport.relayIdentity !== null || transport.endpointOrigin !== expected.upstreamOrigin) return null;
  if (transport.id !== binding.transportId || !bindingMatches(binding, expected.binding) || !bindingMatches(value.binding, binding)) return null;
  if (Object.keys(value).length !== Object.keys(expected).length) return null;
  for (const key of ['version', 'configurationId', 'region', 'upstreamOrigin', 'sourceUrl', 'reviewedAt'] as const)
    if (value[key] !== expected[key]) return null;
  for (const key of ['modelIds', 'endpoints', 'inputModalities'] as const)
    if (!Array.isArray(value[key]) || value[key].length !== expected[key].length || value[key].some((item, index) => item !== expected[key][index])) return null;
  return expected;
}
