import type { ContentPart } from "@quixi/core/model";
import type { Transformations } from "./portability.ts";
/** Provider-specific output parts and what a request does with them
 * (product §3.3: citations transformed, provider-specific artifacts degraded).
 *
 * Reviewed on 2026-09-11 against the Anthropic Messages input contract and the
 * Chat Completions assistant message parameter: a text block's `citations`
 * input needs the cited document blocks, which a canonical Citation part does
 * not carry; Chat Completions accepts no annotations on input; unknown block
 * types are rejected. So a Citation becomes a plain source note, an output
 * StructuredData value is flattened to its JSON text, a provider refusal
 * marker (whose text is already a Text part) and any raw-only output artifact
 * located in this generation's own stream are dropped. Import-derived
 * artifacts keep their locators and stay for the mapper's named refusal. */
export type OutputTransformation = Extract<keyof Transformations, "citationsTransformed" | "structuredDataFlattened" | "providerArtifactsDegraded">;
const FLATTENED_LIMIT = 65_536;
export function transformOutputPart(part: ContentPart): { part: ContentPart | null; transformation: OutputTransformation | null } {
  if (part.kind === "Citation") {
    const label = part.data.label?.trim() || null, url = part.data.url?.trim() || null;
    const note = label && url ? `${label} — ${url}` : label ?? url;
    return { part: note ? { id: part.id, messageId: part.messageId, order: part.order, kind: "Text", data: { text: `[Source: ${note}]` } } : null, transformation: "citationsTransformed" };
  }
  if (part.kind === "StructuredData") {
    const value = part.data.value;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.type === "string" && value.type.startsWith("provider_"))
      return { part: null, transformation: "providerArtifactsDegraded" };
    const text = JSON.stringify(value);
    if (typeof text !== "string" || text.length > FLATTENED_LIMIT) return { part, transformation: null };
    return { part: { id: part.id, messageId: part.messageId, order: part.order, kind: "Text", data: { text } }, transformation: "structuredDataFlattened" };
  }
  if (part.kind === "ProviderArtifact" && part.data.locator.startsWith("generation-stream/"))
    return { part: null, transformation: "providerArtifactsDegraded" };
  return { part, transformation: null };
}
