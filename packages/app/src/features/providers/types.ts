import type { CapabilityState, HostClient, ProviderBinding, RegionalProcessingEvidence } from '@quixi/core/contracts';
import type { AccountHealth, ModelDescription, ProviderAdapter, ReviewedCatalog } from '@quixi/providers';
export interface ProviderConnection {
  id: string; label: string; binding: ProviderBinding; catalog: ReviewedCatalog;
  /** Operator configuration supplies the actual relay identity/origin through HostClient capabilities. */
  relayAuthorizationRequired: boolean;
  processingRegion?: "us" | "eu";
}
export interface ConfiguredConnection { id: string; label: string; adapter: ProviderAdapter; models: readonly ModelDescription[]; privacy: string | null; regionalProcessing?: RegionalProcessingEvidence }
export interface ProviderSettingsOptions {
  host: HostClient; connections: readonly ProviderConnection[]; credentialCapability: CapabilityState;
  onChange(providers: readonly ConfiguredConnection[]): void;
  /** Clock shared by adapter observations and background refresh scheduling. */
  now?(): number;
  setRelayAuthorization?(destinationId: string, value: Uint8Array | null): Promise<void>;
}
/** What the provider listed during the last connection check. */
export interface ModelDiscovery {
  total: number; reviewed: string[]; unreviewed: string[];
  /** False when the provider reported more pages than the check followed or a listing it could not continue. */
  complete: boolean; pages: number;
}
export interface ConnectionView {
  id: string; label: string; connected: boolean; busy: boolean; health: AccountHealth | null; discovery: ModelDiscovery | null;
  error: string | null; capability: CapabilityState; privacy: string | null; origin: string | null; relayIdentity: string | null;
  catalog: ReviewedCatalog; relayAuthorizationRequired: boolean;
  processingRegion?: "us" | "eu";
  regionalProcessing: RegionalProcessingEvidence | null;
  regionalEligibility: { confirmed: boolean; images: boolean };
}
export interface ProviderSettingsSnapshot {
  loading: boolean; persistence: 'session'|'native'|null; credentialCapability: CapabilityState;
  connections: readonly ConnectionView[]; error: string|null;
}
