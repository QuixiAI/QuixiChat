import type { JsonObject } from "@quixi/core/model";
import { assertRoutingTarget, assertRoutingRequirements } from "@quixi/core/contracts";
import type { RoutingTarget, RoutingRequirements } from "@quixi/core/contracts";
export type { RoutingRequirements } from "@quixi/core/contracts";
import type { CompatibilityReport } from "@quixi/providers";
import type { RequestCostAssessment } from "./request-cost.ts";
import { describePrivacyClass, parseFallbackPolicy } from "./fallback.ts";

/** A conversation's routing profile: the selected connection is the primary;
 * candidates are tried in order before the first attempt (health, capability,
 * privacy, context, cost) and again after a failed attempt. */
export interface RoutingProfile {
  alias: string | null;
  primary?: RoutingTarget;
  aliasSource?: { id: string; revision: number };
  candidates: { provider: string; model: string }[];
  requirements: RoutingRequirements;
  allowPrivacyChange: boolean;
}

export const ROUTING_PROFILE_VERSION = 2;
export const ROUTING_CANDIDATE_LIMIT = 8;
export const EMPTY_ROUTING_PROFILE: RoutingProfile = {
  alias: null,
  candidates: [],
  requirements: {},
  allowPrivacyChange: false,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Read legacy fallback/profile versions and explicit v4 cost/v5 region profiles.
 * New requirements must use their version so older readers cannot omit them. */
export function parseRoutingProfile(profile: JsonObject | null): RoutingProfile | null {
  if (!profile) return null;
  if (isRecord(profile.requirements) && "processingRegion" in profile.requirements && profile.version !== 5) return null;
  if (profile.version === 1) {
    const fallback = parseFallbackPolicy(profile);
    return fallback
      ? {
          alias: null,
          candidates: [{ provider: fallback.provider, model: fallback.model }],
          requirements: {},
          allowPrivacyChange: fallback.allowPrivacyChange,
        }
      : null;
  }
  if (profile.version !== ROUTING_PROFILE_VERSION && profile.version !== 3 && profile.version !== 4 && profile.version !== 5) return null;
  if (profile.requirements !== undefined) {
    try { assertRoutingRequirements(profile.requirements); } catch { return null; }
  }
  if (isRecord(profile.requirements) && "maxEstimatedRequestCost" in profile.requirements && profile.version !== 4 && profile.version !== 5) return null;
  if (profile.version === 4 && (!isRecord(profile.requirements) || profile.requirements.maxEstimatedRequestCost === undefined)) return null;
  if (profile.version === 5 && (!isRecord(profile.requirements) || profile.requirements.processingRegion === undefined)) return null;
  if (profile.version === 3 || profile.version === 4 || profile.version === 5) {
    try {
      if (profile.version === 3 || profile.primary !== undefined) assertRoutingTarget(profile.primary);
      assertRoutingRequirements(profile.requirements);
      if (!Array.isArray(profile.candidates) || profile.candidates.length > ROUTING_CANDIDATE_LIMIT) return null;
      for (const candidate of profile.candidates) assertRoutingTarget(candidate);
      if (typeof profile.allowPrivacyChange !== "boolean") return null;
    } catch { return null; }
  }
  const candidates: RoutingProfile["candidates"] = [];
  if (Array.isArray(profile.candidates))
    for (const item of profile.candidates.slice(0, ROUTING_CANDIDATE_LIMIT)) {
      if (!isRecord(item)) return null;
      const { provider, model } = item;
      if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return null;
      candidates.push({ provider, model });
    }
  const requirements: RoutingRequirements = {};
  if (isRecord(profile.requirements)) {
    const source = profile.requirements;
    if (source.tools === true) requirements.tools = true;
    if (source.images === true) requirements.images = true;
    if (typeof source.contextAtLeast === "number" && Number.isSafeInteger(source.contextAtLeast) && source.contextAtLeast > 0)
      requirements.contextAtLeast = source.contextAtLeast;
    if (typeof source.maxRequestCost === "string" && /^\d+(\.\d+)?$/.test(source.maxRequestCost))
      requirements.maxRequestCost = source.maxRequestCost;
    if ((profile.version === 4 || profile.version === 5) && typeof source.maxEstimatedRequestCost === "string") requirements.maxEstimatedRequestCost = source.maxEstimatedRequestCost;
    if (profile.version === 5 && (source.processingRegion === "us" || source.processingRegion === "eu")) requirements.processingRegion = source.processingRegion;
  }
  return {
    alias: typeof profile.alias === "string" && profile.alias.trim() ? profile.alias.slice(0, 64) : null,
    ...((profile.version === 3 || profile.version === 4 || profile.version === 5) && profile.primary ? { primary: { ...(profile.primary as unknown as RoutingTarget) } } : {}),
    ...((profile.version === 3 || profile.version === 4 || profile.version === 5) && isRecord(profile.aliasSource) && typeof profile.aliasSource.id === "string" && typeof profile.aliasSource.revision === "number"
      ? { aliasSource: { id: profile.aliasSource.id, revision: profile.aliasSource.revision } } : {}),
    candidates,
    requirements,
    allowPrivacyChange: profile.allowPrivacyChange === true,
  };
}

export const isEmptyRoutingProfile = (profile: RoutingProfile): boolean =>
  profile.alias === null &&
  !profile.primary &&
  !profile.candidates.length &&
  !Object.keys(profile.requirements).length &&
  !profile.allowPrivacyChange;

/** The routing profile field to store: null when the profile is empty and
 * nothing else is recorded in the field. */
export function routingProfileJson(
  existing: JsonObject | null,
  profile: RoutingProfile | null,
): JsonObject | null {
  const rest: JsonObject = { ...(existing ?? {}) };
  for (const key of ["version", "fallback", "alias", "candidates", "requirements", "allowPrivacyChange", "primary", "aliasSource"])
    delete rest[key];
  if ((!profile || isEmptyRoutingProfile(profile)) && !Object.keys(rest).length) return null;
  const value = profile ?? EMPTY_ROUTING_PROFILE;
  return {
    ...rest,
    version: value.requirements.processingRegion !== undefined ? 5 : value.requirements.maxEstimatedRequestCost !== undefined ? 4 : value.primary ? 3 : ROUTING_PROFILE_VERSION,
    ...(value.primary ? { primary: { ...value.primary } } : {}),
    ...(value.aliasSource ? { aliasSource: { ...value.aliasSource } } : {}),
    alias: value.alias,
    candidates: value.candidates.map((item) => ({ ...item })),
    requirements: { ...value.requirements },
    allowPrivacyChange: value.allowPrivacyChange,
  };
}

/** One candidate as the composer resolves it now. */
export interface RouteCandidate {
  requested: { provider: string; model: string };
  provider: { id: string; label: string; privacy: string | null } | null;
  model: {
    id: string;
    name: string;
    capabilities: { tools: string; images: string; contextWindow: number | null };
  } | null;
  health: { blocksSending: boolean; label: string; detail: string | null } | null;
  /** The active path analysed against this candidate, when available. */
  report: CompatibilityReport | null;
  /** Current request budget; missing assessment refuses a configured cost cap. */
  cost: RequestCostAssessment | null;
  /** Evidence for remote content processing; absence refuses a required region. */
  region?: { allowed: boolean; reason: string; basis: string | null };
}

export interface RouteDecision {
  chosen: RouteCandidate | null;
  /** Position in [primary, ...candidates]; 0 is the selected connection. */
  chosenIndex: number;
  /** One line per candidate examined, in order. */
  reasons: string[];
}

const tokens = (value: number) => value.toLocaleString("en-US");

export const describeCandidate = (candidate: RouteCandidate): string =>
  candidate.provider && candidate.model
    ? `${candidate.provider.label} · ${candidate.model.name}`
    : `${candidate.requested.provider} · ${candidate.requested.model}`;

/** Why a candidate does not qualify, or null when it does. `notes` collects
 * facts that do not disqualify but should be said. */
function disqualify(
  candidate: RouteCandidate,
  index: number,
  primaryPrivacy: string | null,
  requirements: RoutingRequirements,
  allowPrivacyChange: boolean,
  notes: string[],
): string | null {
  if (!candidate.provider) return "not configured on this device";
  if (!candidate.model) return `${candidate.provider.label} has no reviewed model "${candidate.requested.model}"`;
  if (index > 0 && candidate.provider.privacy !== primaryPrivacy && !allowPrivacyChange)
    return `would change the privacy class from ${describePrivacyClass(primaryPrivacy)} to ${describePrivacyClass(candidate.provider.privacy)}, which this conversation does not allow`;
  if (candidate.health?.blocksSending)
    return `cannot send now: ${candidate.health.label}${candidate.health.detail ? ` · ${candidate.health.detail}` : ""}`;
  const { capabilities } = candidate.model;
  if (requirements.tools && capabilities.tools !== "supported") return "does not declare tool support";
  if (requirements.images && capabilities.images !== "supported") return "does not declare image input";
  if (requirements.processingRegion !== undefined) {
    if (!candidate.region) return "remote content-processing region has not been assessed";
    if (!candidate.region.allowed) return candidate.region.reason;
    notes.push(candidate.region.reason);
  }
  if (requirements.contextAtLeast !== undefined) {
    if (capabilities.contextWindow === null) return `has no declared context window (at least ${tokens(requirements.contextAtLeast)} required)`;
    if (capabilities.contextWindow < requirements.contextAtLeast)
      return `context window ${tokens(capabilities.contextWindow)} is below ${tokens(requirements.contextAtLeast)}`;
  }
  if (requirements.maxRequestCost !== undefined || requirements.maxEstimatedRequestCost !== undefined) {
    if (!candidate.cost) return "request cost has not been assessed";
    if (!candidate.cost.allowed) return candidate.cost.reason;
    notes.push(candidate.cost.reason);
  }
  return null;
}

/** The first candidate in [primary, ...candidates] that qualifies. A primary
 * whose only failure is a report refusing the path is still chosen when
 * nothing else qualifies, so the compatibility report can explain it and
 * sending stays refused by that report. */
export function chooseRoute(
  profile: RoutingProfile | null,
  primary: RouteCandidate,
  candidates: readonly RouteCandidate[],
): RouteDecision {
  const requirements = profile?.requirements ?? {};
  const allowPrivacyChange = profile?.allowPrivacyChange ?? false;
  const all = [primary, ...candidates];
  const reasons: string[] = [];
  let unsendablePrimary = false;
  for (let index = 0; index < all.length; index++) {
    const candidate = all[index]!;
    const name = describeCandidate(candidate);
    const notes: string[] = [];
    const reason = disqualify(candidate, index, primary.provider?.privacy ?? null, requirements, allowPrivacyChange, notes);
    if (reason) {
      reasons.push(`${name}: skipped — ${reason}.`);
      continue;
    }
    if (candidate.report && !candidate.report.sendable) {
      if (index === 0) unsendablePrimary = true;
      reasons.push(`${name}: skipped — cannot carry this path (see the compatibility report).`);
      continue;
    }
    reasons.push(`${name}: chosen${notes.length ? ` (${notes.join("; ")})` : ""}.`);
    return { chosen: candidate, chosenIndex: index, reasons };
  }
  if (unsendablePrimary) {
    reasons[0] = `${describeCandidate(primary)}: chosen; its compatibility report refuses the path, so sending waits on that report.`;
    return { chosen: primary, chosenIndex: 0, reasons };
  }
  return { chosen: null, chosenIndex: -1, reasons };
}
