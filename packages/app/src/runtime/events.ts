import type { ThreadEvent } from "@quixi/core/model";

/** One line per recorded conversation event, from its recorded details only. */
export function describeThreadEvent(
  event: ThreadEvent,
  providerLabel: (providerId: string) => string = (id) => id,
): string {
  const when = new Date(event.createdAt ?? event.recordedAt).toLocaleString();
  const details = event.details as Record<string, unknown>;
  if (event.type === "ContextCompaction" && details.action === "start_branch")
    return `${when} · Fresh branch started from ${String(details.sourceLeafMessageId)} · only the system prompt carried forward; earlier messages remain in history · context ${String(details.contextSnapshotId)}`;
  if (event.type === "ContextCompaction" && details.action === "exclude_attachments" && Array.isArray(details.excludedPartIds))
    return `${when} · Context compaction: ${details.excludedPartIds.length ? `${details.excludedPartIds.length} attachment occurrence(s) excluded from requests` : "attachment exclusions cleared"} · original history retained · context ${String(details.contextSnapshotId)}`;
  if (event.type === "ContextCompaction" && ["summary_proposed", "apply_summary", "clear_summary"].includes(String(details.action)))
    return `${when} · ${details.action === "summary_proposed" ? "Summary proposal saved for review" : details.action === "apply_summary" ? "Reviewed summary applied" : details.reason === "start_branch" ? "Summary cleared for fresh branch" : "Summary cleared; full history restored to requests"} · original history retained${details.contextSnapshotId ? ` · context ${String(details.contextSnapshotId)}` : ""}`;
  if (event.type === "ProviderSwitch") {
    const from = details.from as { provider?: string; model?: string } | undefined;
    const to = details.to as { provider?: string; model?: string } | undefined;
    const count = (key: string) => (typeof details[key] === "number" ? (details[key] as number) : 0);
    return `${when} · Switched ${providerLabel(String(from?.provider ?? "unknown"))} ${from?.model ?? ""} → ${providerLabel(String(to?.provider ?? "unknown"))} ${to?.model ?? ""} · ${count("preserved")} preserved · ${count("transformed")} transformed · ${count("omitted")} omitted`;
  }
  if (event.type === "AutomaticFallback") {
    const from = details.from as { provider?: string; model?: string } | undefined;
    const to = details.to as { provider?: string; model?: string } | undefined;
    return `${when} · Fell back ${providerLabel(String(from?.provider ?? "unknown"))} ${from?.model ?? ""} → ${providerLabel(String(to?.provider ?? "unknown"))} ${to?.model ?? ""} · ${typeof details.reason === "string" ? details.reason : "no reason recorded"}`;
  }
  if (event.type === "Compare" && Array.isArray(details.candidates)) {
    const candidates = details.candidates as { provider?: string; model?: string }[];
    return `${when} · Compared ${candidates.length} answers: ${candidates.map((candidate) => `${providerLabel(String(candidate.provider ?? "unknown"))} ${candidate.model ?? ""}`).join(", ")} · every answer is kept as its own branch`;
  }
  if (event.type === "Migration") {
    const from = details.from as { provider?: string; model?: string } | null | undefined;
    const to = details.to as { provider?: string; model?: string } | undefined;
    const transformations = Array.isArray(details.transformations) ? (details.transformations as string[]) : [];
    return `${when} · Migrated ${from ? `${providerLabel(String(from.provider ?? "unknown"))} ${from.model ?? ""}` : "no primary"} → ${providerLabel(String(to?.provider ?? "unknown"))} ${to?.model ?? ""} (reviewed bulk migration)${transformations.length ? ` · ${transformations.join("; ")}` : ""} · history unchanged`;
  }
  if (event.type === "Critique") {
    const reviewed = details.reviewed as { provider?: string; model?: string } | undefined;
    return `${when} · Critique of the ${providerLabel(String(reviewed?.provider ?? "unknown"))} ${reviewed?.model ?? ""} answer · the reviewed answer is unchanged`;
  }
  return `${when} · ${event.type}`;
}
