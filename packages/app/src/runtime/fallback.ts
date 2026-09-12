import type { JsonObject } from "@quixi/core/model";
import type { CompatibilityReport } from "@quixi/providers";

/** A conversation's fallback: one target to continue with when the selected
 * connection fails, and whether that may change the privacy class. Stored in
 * the thread state's routing profile. */
export interface FallbackPolicy {
  provider: string;
  model: string;
  allowPrivacyChange: boolean;
}

export const ROUTING_PROFILE_VERSION = 1;

export const PRIVACY_LABELS: Record<string, string> = {
  local: "Local",
  direct_provider: "Direct provider",
  quixi_relay: "Quixi relay",
  self_hosted_remote: "Self-hosted remote",
  custom_remote: "Custom remote",
};

export const describePrivacyClass = (value: string | null): string =>
  PRIVACY_LABELS[value ?? ""] ?? "Unknown";

/** The fallback recorded in a routing profile, or null when it has none or
 * the stored shape is not one this build understands. */
export function parseFallbackPolicy(profile: JsonObject | null): FallbackPolicy | null {
  if (!profile || profile.version !== ROUTING_PROFILE_VERSION) return null;
  const fallback = profile.fallback;
  if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) return null;
  const { provider, model, allowPrivacyChange } = fallback as Record<string, unknown>;
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return null;
  return { provider, model, allowPrivacyChange: allowPrivacyChange === true };
}

/** The routing profile to store for a policy; null clears the profile when
 * nothing else is recorded in it. */
export function routingProfileWith(
  existing: JsonObject | null,
  policy: FallbackPolicy | null,
): JsonObject | null {
  const rest: JsonObject = { ...(existing ?? {}) };
  delete rest.fallback;
  delete rest.version;
  if (!policy && !Object.keys(rest).length) return null;
  return {
    ...rest,
    version: ROUTING_PROFILE_VERSION,
    fallback: policy ? { ...policy } : null,
  };
}

export interface FallbackCandidate {
  provider: { id: string; label: string; privacy: string | null };
  /** Null when the policy names a model the connection's catalog lacks. */
  model: { id: string; name: string } | null;
  health: { blocksSending: boolean; label: string; detail: string | null };
}

export interface FallbackFailure {
  status: string;
  code: string | null;
  message: string;
}

export type FallbackDecision =
  | { apply: true; reason: string }
  | { apply: false; reason: string };

/** Whether the fallback may run after a primary attempt ended without
 * completing. Every refusal states its reason; a user stop never falls back,
 * a privacy-class change needs the policy's explicit allowance, a target that
 * cannot send now or cannot carry the path is refused. */
export function evaluateFallback(
  policy: FallbackPolicy,
  primary: { label: string; provider: string; model: string; privacy: string | null },
  candidate: FallbackCandidate | null,
  failure: FallbackFailure,
  report: CompatibilityReport | null,
): FallbackDecision {
  const primaryOutcome = `${primary.label} ${failure.status}: ${failure.message}`;
  if (failure.status === "cancelled" || failure.status === "stopped")
    return { apply: false, reason: "The attempt was stopped by you; fallback applies only to provider failures." };
  if (failure.status === "complete")
    return { apply: false, reason: "The attempt completed; nothing to fall back from." };
  if (!candidate)
    return { apply: false, reason: `${primaryOutcome}. The fallback connection "${policy.provider}" is not configured on this device.` };
  const label = candidate.provider.label;
  if (!candidate.model)
    return { apply: false, reason: `${primaryOutcome}. ${label} has no reviewed model "${policy.model}".` };
  const target = `${label} · ${candidate.model.name}`;
  if (candidate.provider.id === primary.provider && candidate.model.id === primary.model)
    return { apply: false, reason: `${primaryOutcome}. The fallback target is the connection and model that failed.` };
  if (candidate.provider.privacy !== primary.privacy && !policy.allowPrivacyChange)
    return {
      apply: false,
      reason: `${primaryOutcome}. Continuing with ${target} would change the privacy class from ${describePrivacyClass(primary.privacy)} to ${describePrivacyClass(candidate.provider.privacy)}, which this conversation's fallback does not allow.`,
    };
  if (candidate.health.blocksSending)
    return {
      apply: false,
      reason: `${primaryOutcome}. ${target} cannot send now: ${candidate.health.label}${candidate.health.detail ? ` · ${candidate.health.detail}` : ""}.`,
    };
  if (!report || !report.sendable) {
    const refusals = report
      ? [
          ...report.blocked.map((item) => `${item.kind ?? "part"} (${item.code})`),
          ...report.constraints.map((issue) => issue.message),
        ]
      : ["no compatibility report"];
    return { apply: false, reason: `${primaryOutcome}. ${target} cannot carry this path: ${refusals.join("; ")}.` };
  }
  return {
    apply: true,
    reason: `${primaryOutcome}. Continued with ${target}${candidate.provider.privacy !== primary.privacy ? ` (privacy class ${describePrivacyClass(primary.privacy)} → ${describePrivacyClass(candidate.provider.privacy)}, allowed by this conversation)` : ""}.`,
  };
}
