import type { JsonObject } from "../model/types.ts";
import { isQuixiId } from "../model/validation.ts";
import { jsonByteLength } from "./serialization.ts";

export interface RoutingTarget { provider: string; model: string }
export interface RoutingRequirements {
  tools?: boolean;
  images?: boolean;
  contextAtLeast?: number;
  /** Maximum estimated input cost for the counted prompt, USD. */
  maxRequestCost?: string;
  /** Maximum estimated counted input plus selected output limit cost per attempt, USD. */
  maxEstimatedRequestCost?: string;
  /** Required remote content-processing region for every request attempt and count. */
  processingRegion?: "us" | "eu";
}
export interface RoutingAlias {
  id: string;
  name: string;
  primary: RoutingTarget;
  candidates: RoutingTarget[];
  requirements: RoutingRequirements;
  allowPrivacyChange: boolean;
}
export interface RoutingAliases { version: 1; revision: number; aliases: RoutingAlias[] }
export const ROUTING_ALIAS_LIMITS = Object.freeze({ aliases: 32, candidates: 8, bytes: 16384 });
export interface RoutingAliasOperations {
  readRoutingAliases: { args: null; result: RoutingAliases };
  putRoutingAlias: { args: { expectedRevision: number; alias: RoutingAlias }; result: RoutingAliases };
  removeRoutingAlias: { args: { expectedRevision: number; aliasId: string }; result: RoutingAliases };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid routing alias object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unsupported routing alias field");
}
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
export function assertRoutingTarget(value: unknown): asserts value is RoutingTarget {
  const target = record(value); keys(target, ["provider", "model"]);
  if (!text(target.provider, 128) || !text(target.model, 256)) throw new Error("Routing targets need a connection id and model id within their length limits");
}
export function assertRoutingRequirements(value: unknown): asserts value is RoutingRequirements {
  const requirements = record(value); keys(requirements, ["tools", "images", "contextAtLeast", "maxRequestCost", "maxEstimatedRequestCost", "processingRegion"]);
  if ("processingRegion" in requirements && requirements.processingRegion !== "us" && requirements.processingRegion !== "eu") throw new Error("Required processing region must be us or eu");
  for (const key of ["tools", "images"]) if (key in requirements && typeof requirements[key] !== "boolean") throw new Error("Invalid routing capability requirement");
  if ("contextAtLeast" in requirements && (typeof requirements.contextAtLeast !== "number" || !Number.isSafeInteger(requirements.contextAtLeast) || requirements.contextAtLeast < 1)) throw new Error("Minimum context must be a positive whole number");
  if ("maxRequestCost" in requirements && (typeof requirements.maxRequestCost !== "string" || !/^\d{1,9}(\.\d{1,9})?$/.test(requirements.maxRequestCost))) throw new Error("Estimated input cost must be a USD decimal with at most nine digits on either side of the decimal point");
  if ("maxEstimatedRequestCost" in requirements && (typeof requirements.maxEstimatedRequestCost !== "string" || !/^\d{1,9}(\.\d{1,9})?$/.test(requirements.maxEstimatedRequestCost))) throw new Error("Estimated request cost must be a USD decimal with at most nine digits on either side of the decimal point");
}
export function assertRoutingAlias(value: unknown): asserts value is RoutingAlias {
  const alias = record(value); keys(alias, ["id", "name", "primary", "candidates", "requirements", "allowPrivacyChange"]);
  if (!isQuixiId(alias.id) || !text(alias.name, 64) || typeof alias.allowPrivacyChange !== "boolean") throw new Error("An alias needs an id, a name of 1–64 characters, and a privacy allowance");
  assertRoutingTarget(alias.primary); assertRoutingRequirements(alias.requirements);
  if (!Array.isArray(alias.candidates) || alias.candidates.length > ROUTING_ALIAS_LIMITS.candidates) throw new Error("An alias supports at most eight fallback candidates");
  const seen = new Set([JSON.stringify([alias.primary.provider, alias.primary.model])]);
  for (const candidate of alias.candidates) {
    assertRoutingTarget(candidate);
    const key = JSON.stringify([candidate.provider, candidate.model]);
    if (seen.has(key)) throw new Error("A routing target may appear only once in an alias");
    seen.add(key);
  }
}
export function assertRoutingAliases(value: unknown): asserts value is RoutingAliases {
  const registry = record(value); keys(registry, ["version", "revision", "aliases"]);
  if (registry.version !== 1 || !revision(registry.revision) || !Array.isArray(registry.aliases) || registry.aliases.length > ROUTING_ALIAS_LIMITS.aliases) throw new Error("Invalid or unsupported routing alias registry (maximum 32 aliases)");
  const ids = new Set<string>(), names = new Set<string>();
  for (const alias of registry.aliases) {
    assertRoutingAlias(alias);
    if (ids.has(alias.id) || names.has(alias.name.toLowerCase())) throw new Error("Routing aliases must have unique ids and names");
    ids.add(alias.id); names.add(alias.name.toLowerCase());
  }
  if (jsonByteLength(value) > ROUTING_ALIAS_LIMITS.bytes) throw new Error("Routing aliases exceed the 16 KiB local settings limit");
}
export function assertRoutingAliasArgs(operation: keyof RoutingAliasOperations, value: unknown) {
  if (operation === "readRoutingAliases") { if (value !== null) throw new Error("Reading routing aliases takes null arguments"); return; }
  const args = record(value);
  keys(args, operation === "putRoutingAlias" ? ["expectedRevision", "alias"] : ["expectedRevision", "aliasId"]);
  if (!revision(args.expectedRevision)) throw new Error("Invalid routing alias revision");
  if (operation === "putRoutingAlias") assertRoutingAlias(args.alias);
  else if (!isQuixiId(args.aliasId)) throw new Error("Invalid routing alias id");
}
/** An immutable canonical profile, independent of all later registry changes. */
export function routingAliasSnapshot(alias: RoutingAlias, sourceRevision: number): JsonObject {
  assertRoutingAlias(alias);
  if (!revision(sourceRevision)) throw new Error("Invalid routing alias source revision");
  return { version: alias.requirements.processingRegion !== undefined ? 5 : alias.requirements.maxEstimatedRequestCost === undefined ? 3 : 4, alias: alias.name, primary: { ...alias.primary },
    candidates: alias.candidates.map(value => ({ ...value })), requirements: { ...alias.requirements },
    allowPrivacyChange: alias.allowPrivacyChange, aliasSource: { id: alias.id, revision: sourceRevision } };
}
