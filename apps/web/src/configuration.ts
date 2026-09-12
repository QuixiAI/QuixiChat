import { webProviderConnections } from "./host/provider-connections.ts";
import type { ReviewedRelayConfiguration } from "./host/provider-connections.ts";
/** Build-time operator configuration contains routing metadata, never credentials. */
function parseWebProviders(value: string | undefined) {
  if (!value?.trim()) return webProviderConnections(null);
  if (value.length > 8192)
    throw new Error("Provider relay configuration exceeds its size limit.");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Provider relay configuration must be an object.");
  const relay = parsed as ReviewedRelayConfiguration;
  if (
    typeof relay.origin !== "string" ||
    typeof relay.operator !== "string" ||
    !relay.destinations ||
    typeof relay.destinations.openai !== "string" ||
    typeof relay.destinations.anthropic !== "string"
  )
    throw new Error(
      "Provider relay configuration requires its origin, operator and both registered destination IDs.",
    );
  return webProviderConnections(relay);
}

/** An operator routing error must not prevent access to local history. */
export function configuredWebProviders(value: string | undefined) {
  try {
    return { ...parseWebProviders(value), notice: null };
  } catch {
    return {
      ...webProviderConnections(null),
      notice:
        "Live provider connections are unavailable because this site’s relay configuration is invalid. Your local history, imports, search and exports remain available.",
    };
  }
}
