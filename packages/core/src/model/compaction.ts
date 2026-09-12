import type { ContextCompaction, ContentPart } from "./types.ts";
import { isQuixiId } from "./validation.ts";

export const MAX_EXCLUDED_PARTS = 64;
export const ATTACHMENT_EXCLUSION_MARKER = "[Attachment omitted by your context choice.]";
export function assertAttachmentCompaction(value: unknown): asserts value is ContextCompaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context compaction policy");
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).some(key => !["version", "excludedPartIds", ...(policy.version === 2 ? ["summary"] : [])].includes(key)) || ![1, 2].includes(Number(policy.version)) || typeof policy.version !== "number" || !Array.isArray(policy.excludedPartIds) || policy.excludedPartIds.length > MAX_EXCLUDED_PARTS || !policy.excludedPartIds.every(isQuixiId) || new Set(policy.excludedPartIds).size !== policy.excludedPartIds.length)
    throw new Error("Unsupported or invalid context compaction policy; at most 64 distinct attachment occurrences are supported");
  if (policy.version === 2) {
    if (!Object.hasOwn(policy, "summary")) throw new Error("Missing reviewed summary policy");
    if (policy.summary !== null) {
      const summary = policy.summary as Record<string, unknown>;
      if (!summary || typeof summary !== "object" || Array.isArray(summary) || Object.keys(summary).sort().join(",") !== "proposalId,reviewedText,reviewedTextSha256,throughMessageId" || !isQuixiId(summary.proposalId) || !isQuixiId(summary.throughMessageId) || typeof summary.reviewedText !== "string" || !summary.reviewedText.trim() || utf8ByteLength(summary.reviewedText) > 16384 || typeof summary.reviewedTextSha256 !== "string" || !/^[0-9a-f]{64}$/.test(summary.reviewedTextSha256)) throw new Error("Invalid reviewed summary");
    }
  }
}
export const isAttachmentPart = (part: ContentPart): part is Extract<ContentPart, { kind: "Image" | "File" | "Audio" }> =>
  part.kind === "Image" || part.kind === "File" || part.kind === "Audio";
/** This is the sole exclusion transformation. It runs before attachment reads. */
export function compactAttachment(part: ContentPart, excluded: ReadonlySet<string>): ContentPart {
  if (!excluded.has(part.id)) return part;
  if (!isAttachmentPart(part)) throw new Error("Context compaction references a non-attachment part");
  return { id: part.id, messageId: part.messageId, order: part.order, kind: "Text", data: { text: ATTACHMENT_EXCLUSION_MARKER } };
}

export const contextSummary = (context: { compaction?: ContextCompaction }) => context.compaction?.version === 2 ? context.compaction.summary : null;

/** UTF-8 length, including replacement bytes for lone UTF-16 surrogates, without host globals. */
export function utf8ByteLength(value:string):number {let size=0;for(const character of value){const code=character.codePointAt(0)!;size+=code<128?1:code<2048?2:code<65536?3:4;}return size;}
