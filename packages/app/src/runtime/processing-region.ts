import type { Generation, JsonValue } from '@quixi/core/model';
import { canonicalJson } from '@quixi/core/contracts';
import type { RegionalProcessingEvidence, RoutingRequirements } from '@quixi/core/contracts';
import { reviewedRegionalTransport, regionalLabel } from '@quixi/providers';
import type { ProviderAdapter } from '@quixi/providers';
export interface ProcessingRegionAssessment { allowed: boolean; reason: string; basis: string | null }
type Target = { adapter: ProviderAdapter; regionalProcessing?: RegionalProcessingEvidence };
/** Region evidence comes from configured connections admitted by the settings
 * controller. Its adapter still enforces current credential eligibility when
 * preparing and dispatching; this evaluator cannot grant that permission. */
export function assessProcessingRegion(requirements: RoutingRequirements, provider: Target | null, modelId: string): ProcessingRegionAssessment {
  const required = requirements.processingRegion;
  if (required === undefined) return { allowed: true, reason: 'No processing region required.', basis: null };
  if (required !== 'us' && required !== 'eu') return { allowed: false, reason: 'The required processing region is unsupported.', basis: null };
  const deny = (reason: string): ProcessingRegionAssessment => ({ allowed: false, reason, basis: null });
  const evidence = provider?.regionalProcessing;
  if (!provider || !evidence) return deny(`Processing region is unknown; ${regionalLabel(required)} is required.`);
  if (evidence.region !== 'us' && evidence.region !== 'eu') return deny('The connection has unsupported processing-region evidence.');
  const reviewed = reviewedRegionalTransport(evidence.region, provider.adapter.binding, {
    id: provider.adapter.binding.transportId, kind: evidence.relay ? 'relay' : 'native_direct', privacy: evidence.relay ? 'custom_remote' : 'direct_provider', endpointOrigin: evidence.relay?.origin ?? evidence.upstreamOrigin,
    relayIdentity: evidence.relay?.operator ?? null, capability: { available: true, permission: 'not_required', reason: null }, regionalProcessing: evidence,
  });
  if (!reviewed || provider.adapter.protocol !== 'openai-compatible' || !reviewed.modelIds.includes(modelId) || !provider.adapter.describeModel(modelId)) return deny('The connection has no matching reviewed processing region for this model and binding.');
  if (reviewed.region !== required) return deny(`Processing region ${regionalLabel(reviewed.region)} does not match required ${regionalLabel(required)}.`);
  return { allowed: true, reason: `Processing region ${regionalLabel(required)} matches the requirement (review ${reviewed.configurationId}).`, basis: reviewed.configurationId };
}
/** Bind asynchronous reviews/counts to evidence as well as adapter identity. */
export function processingRegionKey(provider: Target): string {
  return canonicalJson((provider.regionalProcessing ?? null) as unknown as JsonValue);
}
/** Historical destination identity survives disconnected credentials and review
 * revisions. This is only switch provenance, never current region permission. */
export function regionalAttemptOrigin(attempt: Pick<Generation, 'provider' | 'compatibility'>) {
  if (attempt.provider !== 'openai') return null;
  for (const region of ['us', 'eu'] as const) {
    const prefix = `Processing region ${regionalLabel(region)} matches the requirement (review `;
    const note = attempt.compatibility.find(note => note.startsWith(prefix) && /^[a-zA-Z0-9._-]+\)\.$/.test(note.slice(prefix.length)));
    if (note) {
      const relay = /-[0-9a-f]{64}\)\.$/.test(note.slice(prefix.length));
      return { id: `openai-${region}${relay ? '-relay' : ''}`, label: `OpenAI · ${regionalLabel(region)}${relay ? ' · relay' : ''}`, privacy: relay ? null : 'direct_provider' };
    }
  }
  return null;
}
