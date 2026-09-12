import { jsonByteLength } from "@quixi/core/contracts";
import {
  isQuixiId,
  isReasoningEvidencePart,
  THINKING_RECEIPT_KIND,
  type ContentPart,
} from "@quixi/core/model";
import { Normalizer } from "./normalize.ts";
import { SSEDecoder } from "./sse.ts";
import { LIMITS, StreamFailure, type ProviderEvent, type ProviderInput } from "./types.ts";

/** A complete provider block exactly as the stream closed it (ADR 0031). */
export type ThinkingBlock = Extract<ProviderEvent, { type: "reasoning_block" }>["block"];
/** The version-1 receipt a generation writes for one closed block. */
export interface ThinkingReceipt {
  version: 1;
  protocol: "anthropic";
  generationId: string;
  outputMessageId: string;
  responseId: string;
  model: string;
  returnedModel: string | null;
  index: number;
  source: {
    startRecord: number;
    endRecord: number;
    rawSegmentsThroughCheckpoint: number;
    rawBytesThroughCheckpoint: number;
  };
  block: ThinkingBlock;
}
export type ReasoningEntry = NonNullable<ProviderInput["reasoning"]>[string];
export class ReasoningEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
export { THINKING_RECEIPT_KIND };
const OPENER = /^generation-stream\/record\/(\d{1,9})$/;
function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** The block as the provider contract defines it, or null. Exact keys only:
 * a signed block needs its signature and a redacted block its opaque data. */
export function validateThinkingBlock(value: unknown): ThinkingBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const block = value as Record<string, unknown>;
  const keys = Object.keys(block).sort().join(",");
  if (block.type === "thinking" && keys === "signature,thinking,type" &&
      typeof block.thinking === "string" && typeof block.signature === "string" && block.signature)
    return { type: "thinking", thinking: block.thinking, signature: block.signature };
  if (block.type === "redacted_thinking" && keys === "data,type" && typeof block.data === "string" && block.data)
    return { type: "redacted_thinking", data: block.data };
  return null;
}
/** Escaped JSON bytes of a block, or null beyond the per-block bound. */
export function thinkingBlockBytes(block: ThinkingBlock): number | null {
  try {
    return jsonByteLength(block, LIMITS.reasoningBlockBytes);
  } catch {
    return null;
  }
}
/** Parse and check one receipt's bytes. Every failure names its cause; the
 * caller decides whether a refusal or reconstruction follows. */
export function parseThinkingReceipt(bytes: Uint8Array): ThinkingReceipt {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > LIMITS.reasoningReceiptBytes)
    throw new ReasoningEvidenceError("reasoning_receipt_limit", "The thinking receipt is empty or exceeds its size bound.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ReasoningEvidenceError("reasoning_receipt_malformed", "The thinking receipt is not valid UTF-8 JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReasoningEvidenceError("reasoning_receipt_malformed", "The thinking receipt is not a JSON object.");
  const receipt = value as Record<string, unknown>;
  const source = receipt.source as Record<string, unknown> | undefined;
  const block = validateThinkingBlock(receipt.block);
  if (
    receipt.version !== 1 || receipt.protocol !== "anthropic" ||
    !isQuixiId(receipt.generationId) || !isQuixiId(receipt.outputMessageId) ||
    typeof receipt.responseId !== "string" || !receipt.responseId || receipt.responseId.length > 4096 ||
    typeof receipt.model !== "string" || !receipt.model || receipt.model.length > 256 ||
    (receipt.returnedModel !== null && (typeof receipt.returnedModel !== "string" || receipt.returnedModel.length > 256)) ||
    !safeCount(receipt.index) || receipt.index >= LIMITS.parts ||
    !source || typeof source !== "object" || Array.isArray(source) ||
    !safeCount(source.startRecord) || !safeCount(source.endRecord) || source.startRecord < 1 ||
    source.endRecord <= source.startRecord || source.endRecord > 100_000 ||
    !safeCount(source.rawSegmentsThroughCheckpoint) || !safeCount(source.rawBytesThroughCheckpoint) ||
    !block
  )
    throw new ReasoningEvidenceError("reasoning_receipt_invalid", "The thinking receipt does not match the version-1 contract.");
  if (thinkingBlockBytes(block) === null)
    throw new ReasoningEvidenceError("reasoning_receipt_limit", "The thinking receipt's block exceeds its size bound.");
  return {
    version: 1,
    protocol: "anthropic",
    generationId: receipt.generationId as string,
    outputMessageId: receipt.outputMessageId as string,
    responseId: receipt.responseId,
    model: receipt.model,
    returnedModel: receipt.returnedModel as string | null,
    index: receipt.index,
    source: {
      startRecord: source.startRecord as number,
      endRecord: source.endRecord as number,
      rawSegmentsThroughCheckpoint: source.rawSegmentsThroughCheckpoint as number,
      rawBytesThroughCheckpoint: source.rawBytesThroughCheckpoint as number,
    },
    block,
  };
}
export interface ReasoningBinding {
  /** Verified entries keyed by ReasoningMetadata part ID, ready for a request. */
  reasoning: Record<string, ReasoningEntry>;
  /** Every marker that could not be bound, with one exact reason. Partial or
   * inconsistent evidence binds nothing for the message. */
  unbound: { partId: string; code: string; message: string }[];
  /** The message's receipt and opener evidence parts, never request content. */
  evidencePartIds: string[];
}
/** Bind an assistant message's ReasoningMetadata markers to verified complete
 * blocks. A marker binds only when its opening stream record, its receipt and
 * the receipts' generation, response, model, indexes and record ranges all
 * agree; display summaries and edited copies are never evidence. */
export function bindReasoningEvidence(
  message: { id: string; generationId: string | null; model: string | null },
  parts: readonly ContentPart[],
  receipts: readonly ThinkingReceipt[],
): ReasoningBinding {
  const ordered = [...parts].sort((a, b) => a.order - b.order);
  const markers = ordered.filter((part) => part.kind === "ReasoningMetadata");
  const evidencePartIds = ordered.filter(isReasoningEvidencePart).map((part) => part.id);
  const fail = (code: string, message: string): ReasoningBinding => ({
    reasoning: {},
    unbound: markers.map((part) => ({ partId: part.id, code, message })),
    evidencePartIds,
  });
  if (!markers.length) return { reasoning: {}, unbound: [], evidencePartIds };
  if (message.generationId === null || message.model === null)
    return fail("reasoning_source_unknown", "This reasoning marker has no recorded generation, so no provider block can be verified for it.");
  const openers = ordered.filter(
    (part) =>
      part.kind === "ProviderArtifact" &&
      (part.data.providerKind === "thinking" || part.data.providerKind === "redacted_thinking") &&
      OPENER.test(part.data.locator),
  ) as Extract<ContentPart, { kind: "ProviderArtifact" }>[];
  if (openers.length !== markers.length)
    return fail("reasoning_source_mismatch", "The retained stream locators do not match this message's reasoning markers.");
  if (!receipts.length)
    return fail("reasoning_evidence_missing", "No complete thinking-block receipt is retained for this message.");
  const sorted = [...receipts].sort((a, b) => a.index - b.index);
  for (const receipt of sorted)
    if (receipt.generationId !== message.generationId || receipt.outputMessageId !== message.id || receipt.model !== message.model || receipt.protocol !== "anthropic")
      return fail("reasoning_receipt_foreign", "A retained thinking receipt belongs to a different generation, message or model.");
  if (sorted.length !== markers.length)
    return fail("reasoning_receipt_count", `This message has ${markers.length} reasoning markers but ${sorted.length} complete-block receipts.`);
  const reasoning: Record<string, ReasoningEntry> = {};
  for (const [k, marker] of markers.entries()) {
    const opener = openers[k]!, receipt = sorted[k]!, previous = sorted[k - 1];
    const record = Number(OPENER.exec(opener.data.locator)![1]);
    const redacted = receipt.block.type === "redacted_thinking";
    if (
      marker.kind !== "ReasoningMetadata" || marker.data.redacted !== redacted ||
      opener.data.providerKind !== receipt.block.type ||
      opener.order <= marker.order || (k > 0 && marker.order <= openers[k - 1]!.order) ||
      receipt.source.startRecord !== record ||
      (previous !== undefined && (receipt.index <= previous.index || receipt.source.startRecord < previous.source.endRecord)) ||
      receipt.responseId !== sorted[0]!.responseId
    )
      return fail("reasoning_evidence_mismatch", "The retained receipts disagree with the marker order, block kinds, stream records or response identity of this message.");
    reasoning[marker.id] = { protocol: "anthropic", modelId: message.model, messageId: message.id, index: receipt.index, block: receipt.block };
  }
  return { reasoning, unbound: [], evidencePartIds };
}
/** Replay retained raw stream segments, in part order, through the same
 * decoder and normalizer a live generation uses, and rebuild the receipts a
 * generation recorded before receipts existed. Bounded; any protocol
 * failure or missing identity is a named refusal, never a guess. */
export function reconstructThinkingReceipts(
  segments: readonly Uint8Array[],
  expected: { generationId: string; outputMessageId: string; model: string },
): ThinkingReceipt[] {
  let total = 0;
  for (const segment of segments) {
    total += segment.length;
    if (total > LIMITS.reasoningReconstructionBytes)
      throw new ReasoningEvidenceError("reasoning_reconstruction_limit", "The retained provider stream exceeds the 8 MiB reconstruction bound.");
  }
  const decoder = new SSEDecoder(), normalizer = new Normalizer("anthropic");
  const blocks: Extract<ProviderEvent, { type: "reasoning_block" }>[] = [];
  const sources: { segments: number; bytes: number }[] = [];
  let segmentsSeen = 0, bytesSeen = 0;
  try {
    for (const [at, segment] of segments.entries()) {
      segmentsSeen++;
      bytesSeen += segment.length;
      for (const record of decoder.push(segment, at === segments.length - 1))
        for (const event of normalizer.accept(record))
          if (event.type === "reasoning_block") {
            blocks.push(event);
            sources.push({ segments: segmentsSeen, bytes: bytesSeen });
          }
    }
  } catch (error) {
    const reason = error instanceof StreamFailure ? error.failure.message : "The retained stream could not be replayed.";
    throw new ReasoningEvidenceError("reasoning_reconstruction_failed", `Thinking blocks could not be reconstructed from the retained stream: ${reason}`);
  }
  if (!normalizer.ended || !normalizer.responseId)
    throw new ReasoningEvidenceError("reasoning_reconstruction_incomplete", "The retained stream ended before the provider's terminal marker, so its thinking blocks are not complete.");
  const seen = new Set<number>();
  let bytes = 0;
  return blocks.map((event, at) => {
    const size = thinkingBlockBytes(event.block);
    if (size === null || seen.has(event.index) || (bytes += size) > LIMITS.reasoningTotalBytes)
      throw new ReasoningEvidenceError("reasoning_reconstruction_limit", "The reconstructed thinking blocks exceed their bounds or repeat an index.");
    seen.add(event.index);
    return {
      version: 1,
      protocol: "anthropic",
      generationId: expected.generationId,
      outputMessageId: expected.outputMessageId,
      responseId: normalizer.responseId!,
      model: expected.model,
      returnedModel: normalizer.model,
      index: event.index,
      source: {
        startRecord: event.startRecord,
        endRecord: event.endRecord,
        rawSegmentsThroughCheckpoint: sources[at]!.segments,
        rawBytesThroughCheckpoint: sources[at]!.bytes,
      },
      block: event.block,
    };
  });
}
