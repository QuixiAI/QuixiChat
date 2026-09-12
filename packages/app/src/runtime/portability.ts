import type { CompatibilityReport } from "@quixi/providers";

/** One configured target the active path was analysed against. */
export interface PortabilityTarget {
  provider: { id: string; label: string };
  model: { id: string; name: string };
  report: CompatibilityReport;
  /** This target's own transformations when they differ from the shared
   * ones, such as reasoning blocks it cannot read. */
  transformed?: Transformations;
}

export type PortabilityStatus =
  | "fully_portable"
  | "portable_with_transformations"
  | "provider_dependent"
  | "blocked"
  | "unknown";

export interface PortabilityAssessment {
  status: PortabilityStatus;
  label: string;
  summary: string;
  /** One inspectable reason per target, plus what is never sent. */
  reasons: string[];
}

export const PORTABILITY_LABELS: Record<PortabilityStatus, string> = {
  fully_portable: "Fully portable",
  portable_with_transformations: "Portable with transformations",
  provider_dependent: "Provider-dependent",
  blocked: "Blocked",
  unknown: "Unknown",
};

/** Bound on the targets one assessment analyses; every configured
 * connection's reviewed models are analysed up to this many. */
export const PORTABILITY_TARGET_LIMIT = 32;

const count = (value: number, noun: string) =>
  `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;

export interface Transformations {
  inlinedBlobText: number;
  unavailableImages: number;
  excludedAttachments?: number;
  reviewedSummary?: boolean;
  /** Reasoning markers omitted because no complete provider block is
   * verified for them; the provider contract permits this outside tool use. */
  reasoningOmittedUnverified?: number;
  /** Verified thinking blocks omitted because the target is not the model
   * that produced them. */
  reasoningOmittedForeign?: number;
  /** Citation parts sent as plain source notes: no provider accepts them as
   * citations without the cited documents. */
  citationsTransformed?: number;
  /** StructuredData output values sent as their JSON text. */
  structuredDataFlattened?: number;
  /** Provider refusal markers and raw-only output artifacts of this
   * generation's own stream, which no provider accepts as input. */
  providerArtifactsDegraded?: number;
}

/** The transformations as phrases, in a fixed order; empty when none. */
export function describeTransformations(transformed: Transformations): string[] {
  const phrases: string[] = [];
  if (transformed.reviewedSummary)
    phrases.push("older conversation replaced with its user-reviewed summary; source history is retained");
  if (transformed.excludedAttachments)
    phrases.push(`${count(transformed.excludedAttachments, "attachment occurrence")} replaced with the reviewed context-exclusion marker`);
  if (transformed.inlinedBlobText > 0)
    phrases.push(`${count(transformed.inlinedBlobText, "long text part")} sent inline from stored bytes`);
  if (transformed.unavailableImages > 0)
    phrases.push(
      `${count(transformed.unavailableImages, "image")} without local bytes sent as a note naming the missing file`,
    );
  if (transformed.reasoningOmittedUnverified)
    phrases.push(`${count(transformed.reasoningOmittedUnverified, "reasoning marker")} without a verified provider block omitted, as the thinking contract permits outside tool use`);
  if (transformed.reasoningOmittedForeign)
    phrases.push(`${count(transformed.reasoningOmittedForeign, "thinking block")} from another model omitted because only the producing model can read them`);
  if (transformed.citationsTransformed)
    phrases.push(`${count(transformed.citationsTransformed, "citation")} sent as a plain source note because providers accept citations only with their cited documents`);
  if (transformed.structuredDataFlattened)
    phrases.push(`${count(transformed.structuredDataFlattened, "structured output value")} sent as JSON text`);
  if (transformed.providerArtifactsDegraded)
    phrases.push(`${count(transformed.providerArtifactsDegraded, "provider-specific output record")} omitted because no provider accepts it as input; the original is retained`);
  return phrases;
}

function describeTarget(target: PortabilityTarget, transformed: Transformations): string {
  const name = `${target.provider.label} · ${target.model.name}`;
  const { report } = target;
  if (report.sendable) {
    const carried = `carries all ${count(report.preserved.parts, "part")}`;
    const phrases = describeTransformations(target.transformed ?? transformed);
    return phrases.length
      ? `${name}: ${carried}; ${phrases.join("; ")}.`
      : `${name}: ${carried}.`;
  }
  const byKind = new Map<string, { count: number; codes: Set<string> }>();
  for (const item of report.blocked) {
    const kind = item.kind ?? "part";
    const entry = byKind.get(kind) ?? { count: 0, codes: new Set<string>() };
    entry.count++;
    entry.codes.add(item.code);
    byKind.set(kind, entry);
  }
  const blocked = [...byKind.entries()].map(
    ([kind, entry]) => `${count(entry.count, `${kind} part`)} (${[...entry.codes].join(", ")})`,
  );
  const constraints = report.constraints.map((issue) => issue.message);
  return `${name}: blocked — ${[...blocked, ...constraints].join("; ")}`;
}

/** The active path's portability across the configured targets, from the
 * reports alone. Internal provenance records and empty responses are never
 * sent to any provider, so they do not affect the status. */
export function describePortability(
  targets: readonly PortabilityTarget[],
  transformed: Transformations,
  neverSent: { internalProvenance: number; emptyAssistant: number },
): PortabilityAssessment {
  const note =
    neverSent.internalProvenance + neverSent.emptyAssistant > 0
      ? [
          `${count(neverSent.internalProvenance, "internal provider record")} and ${count(neverSent.emptyAssistant, "empty response")} are never sent to any provider.`,
        ]
      : [];
  if (!targets.length)
    return {
      status: "unknown",
      label: PORTABILITY_LABELS.unknown,
      summary: "No connection is configured, so no target was analysed.",
      reasons: ["Connect a provider to assess where this conversation can continue.", ...note],
    };
  const reasons = targets.map((target) => describeTarget(target, transformed));
  const sendable = targets.filter((target) => target.report.sendable);
  const finish = (status: PortabilityStatus, summary: string): PortabilityAssessment => ({
    status,
    label: PORTABILITY_LABELS[status],
    summary,
    reasons: [...reasons, ...note],
  });
  if (!sendable.length)
    return finish(
      "blocked",
      `None of the ${count(targets.length, "configured target")} can carry the active path.`,
    );
  if (sendable.length < targets.length)
    return finish(
      "provider_dependent",
      `${count(sendable.length, "target")} of ${targets.length} can carry the active path.`,
    );
  const phrases = describeTransformations(transformed);
  const reasoningOmitted = targets.some(
    (target) => target.transformed && describeTransformations(target.transformed).length > phrases.length,
  );
  if (phrases.length || reasoningOmitted)
    return finish(
      "portable_with_transformations",
      `Every configured target can carry the active path; ${[...phrases, ...(reasoningOmitted ? ["some targets omit reasoning blocks they cannot read or verify"] : [])].join("; ")}.`,
    );
  return finish(
    "fully_portable",
    `Every configured target can carry all ${count(targets[0]!.report.preserved.parts, "part")} of the active path.`,
  );
}
