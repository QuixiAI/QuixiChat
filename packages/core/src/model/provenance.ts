import type { ContentPart } from "./types.ts";

/** Transport evidence is ordered independently of the semantic output blocks. */
export function isInternalProvenancePart(part: ContentPart): boolean {
  return (
    part.kind === "ProviderArtifact" &&
    (part.data.providerKind === "quixi.provider.raw-stream-chunk" ||
      part.data.providerKind === "quixi.provider.response-manifest")
  );
}

/** The complete-block receipt a generation writes for a closed Anthropic
 * thinking or redacted block (ADR 0031). */
export const THINKING_RECEIPT_KIND = "quixi.provider.anthropic-thinking-block";

/** Evidence that accompanies a ReasoningMetadata marker: the receipt of the
 * complete provider block, or the raw-stream locators of its opening record
 * and its text/signature deltas. These parts explain a marker and are never
 * request content themselves. */
export function isReasoningEvidencePart(part: ContentPart): boolean {
  if (part.kind !== "ProviderArtifact") return false;
  const { providerKind, locator } = part.data;
  return (
    providerKind === THINKING_RECEIPT_KIND ||
    (["thinking", "redacted_thinking", "thinking_delta", "signature_delta"].includes(providerKind) &&
      locator.startsWith("generation-stream/record/"))
  );
}
