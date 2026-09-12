import { jsonByteLength } from "@quixi/core/contracts";
import type { CanonicalMutation, EntityPage, ViewPage } from "@quixi/core/contracts";
import type { Attachment, ContentPart, ContextSnapshot, Generation, JsonObject, Message, RawObject, ThreadEvent } from "@quixi/core/model";
import { isInternalProvenancePart, isReasoningEvidencePart, THINKING_RECEIPT_KIND, assertAttachmentCompaction, compactAttachment, contextSummary, SUMMARY_LABEL } from "@quixi/core/model";
import { AUDIO_MEDIA_TYPES, normalizeAudioMediaType, FILE_MEDIA_TYPES, IMAGE_MEDIA_TYPES, LIMITS as PROVIDER_LIMITS, bindReasoningEvidence, parseThinkingReceipt, reconstructThinkingReceipts } from "@quixi/providers";
import type { CompatibilityReport, GenerationRun, ProviderAttachment, ProviderInput, ThinkingReceipt } from "@quixi/providers";
import { shapeReasoningForTarget, withReasoningShape } from "../runtime/reasoning.ts";
import { transformOutputPart } from "../runtime/output-parts.ts";
import {
  PORTABILITY_TARGET_LIMIT,
  type PortabilityTarget,
  type Transformations,
} from "../runtime/portability.ts";
import { evaluateFallback, type FallbackFailure } from "../runtime/fallback.ts";
import { parseRoutingProfile } from "../runtime/routing.ts";
import { assessProcessingRegion, processingRegionKey } from "../runtime/processing-region.ts";
import { assessRequestCost } from "../runtime/request-cost.ts";
import type { RoutingRequirements } from "@quixi/core/contracts";
import type { ProviderAdapter } from "@quixi/providers";
import type {
  AppServices,
  ConfiguredProvider,
  LibraryController,
} from "../runtime/library.ts";
import { startCoordinatedGeneration } from "./generation.ts";
const id = () => crypto.randomUUID(),
  page = { maxItems: 64, maxBytes: 900_000, cursor: null };
/** Composer generation settings. An absent key keeps the provider default; the
 * adapter rejects keys the reviewed catalog does not permit before any commit. */
export type GenerationSettings = ProviderInput["parameters"];
/** A switch inspection: the adapter's report for the active path plus the
 * omissions and transformations the workflow itself decides. */
export interface SwitchInspection {
  report: CompatibilityReport;
  omitted: { internalProvenance: number; emptyAssistant: number };
  transformed: Transformations;
  leaf: string;
}
/** The active path analysed against the configured targets. */
export interface PortabilityInspection {
  leaf: string;
  /** True when the path has no sendable message yet. */
  empty: boolean;
  targets: PortabilityTarget[];
  transformed: Transformations;
  neverSent: { internalProvenance: number; emptyAssistant: number };
}
/** How one attempt ended, for the fallback decision. */
export interface AttemptOutcome {
  generationId: string;
  outputId: string;
  status: string;
  failure: { code: string; message: string } | null;
}
/** The conversation's remaining fallback candidates as the composer resolves
 * them: tried in order after a failed attempt, each with its health as of
 * decision time. */
export interface FallbackPlan {
  allowPrivacyChange: boolean;
  primaryLabel: string;
  primaryPrivacy: string | null;
  candidates: () => {
    requested: { provider: string; model: string };
    configured: ConfiguredProvider | null;
    model: { id: string; name: string } | null;
    health: { blocksSending: boolean; label: string; detail: string | null };
  }[];
}
/** A first attempt routed away from the selected connection before trying
 * it, recorded as an AutomaticFallback event with that attempt. */
export interface RoutedAttempt {
  from: { provider: string; model: string; privacy: string | null };
  reason: string;
}
/** The reviewed switch a send records as a ProviderSwitch thread event. */
export interface ProviderSwitch {
  from: { provider: string; model: string; privacy: string | null };
  to: { provider: string; model: string; privacy: string | null };
  preserved: number;
  transformed: number;
  omitted: number;
  blocked: number;
  /** The on-request count for this target when one was taken, and the room
   * the target left for input; both null when unknown. */
  promptTokens: number | null;
  inputRoom: number | null;
  reviewedAt: number;
}
/** Verified original bytes staged for the next user message. Omitted kind is
 * retained for existing image callers; new staging always supplies a kind. */
export interface ComposerAttachment {
  kind?: "Image" | "File" | "Audio";
  transferId: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  filename: string;
  bytes: Uint8Array;
}
export type ComposerImage = ComposerAttachment;
function requestParameters(
  settings: GenerationSettings,
): ProviderInput["parameters"] {
  const parameters: ProviderInput["parameters"] = {
    maxOutputTokens: settings.maxOutputTokens,
  };
  if (settings.temperature !== undefined)
    parameters.temperature = settings.temperature;
  if (settings.topP !== undefined) parameters.topP = settings.topP;
  if (settings.stopSequences?.length)
    parameters.stopSequences = [...settings.stopSequences];
  if (settings.thinkingBudgetTokens !== undefined)
    parameters.thinkingBudgetTokens = settings.thinkingBudgetTokens;
  return parameters;
}
export function createChatController(
  library: LibraryController,
  services: AppServices,
) {
  let run: GenerationRun | null = null,
    busy = false,
    disposed = false,
    cancelled = false;
  // Counts never survive this controller or retain request text/attachment bytes.
  const promptCounts: { adapter: ProviderAdapter; model: string; digest: string; region: string; tokens: number }[] = [];
  async function requestDigest(provider: ConfiguredProvider, input: ProviderInput) {
    const bytes = new TextEncoder().encode(JSON.stringify(provider.adapter.prepare(input).body));
    if (bytes.byteLength > PROVIDER_LIMITS.requestBytes) throw new Error('The counted request exceeds the provider request byte limit.');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function routingRequirements(raw: JsonObject | null | undefined): RoutingRequirements {
    const profile = parseRoutingProfile(raw ?? null);
    if (raw && !profile) throw new Error('This conversation has an unsupported routing profile. Apply a reviewed profile before generating.');
    return profile?.requirements ?? {};
  }
  function requireRegion(provider: ConfiguredProvider, modelId: string, requirements: RoutingRequirements) {
    const region = assessProcessingRegion(requirements, provider, modelId);
    if (!region.allowed) throw new Error(region.reason);
    return region;
  }
  async function beforeRegionDispatch(provider: ConfiguredProvider, input: ProviderInput, threadId: string, contextId: string, original: RoutingRequirements, evidence: string, scope: { profile: string | undefined; revision?: number }) {
    if (cancelled || disposed) throw new Error('Generation cancelled before sending.');
    const current = await services.storage.request(id(), 'readThreadView', { threadId });
    if (current.context.id !== contextId) throw new Error('The conversation context changed before dispatch.');
    if (processingRegionKey(provider) !== evidence) throw new Error('The processing-region evidence changed. Review the connection again.');
    requireRegion(provider, input.modelId, original);
    requireRegion(provider, input.modelId, routingRequirements(current.state.routingProfile));
    if (JSON.stringify(current.state.routingProfile) !== scope.profile || (scope.revision !== undefined && current.state.revision !== scope.revision))
      throw new Error('The conversation policy or revision changed before dispatch. Review the request again.');
    provider.adapter.prepare(input);
    if (cancelled || disposed) throw new Error('Generation cancelled before sending.');
  }
  async function requestCost(provider: ConfiguredProvider, input: ProviderInput, requirements: RoutingRequirements) {
    if (requirements.maxRequestCost === undefined && requirements.maxEstimatedRequestCost === undefined)
      return assessRequestCost({ requirements, pricing: null, contextWindow: null, maxOutputTokens: input.parameters.maxOutputTokens });
    const digest = await requestDigest(provider, input);
    const count = promptCounts.find(value => value.adapter === provider.adapter && value.model === input.modelId && value.digest === digest && value.region === processingRegionKey(provider));
    const report = provider.adapter.analyze(input);
    return assessRequestCost({ requirements, pricing: report.pricing ?? null,
      contextWindow: report.context?.contextWindow ?? null, maxOutputTokens: input.parameters.maxOutputTokens,
      countedInputTokens: count?.tokens ?? null });
  }
  /** Read one verified attachment into memory for the provider request.
   * Returns the record with null bytes when they are unavailable or out of
   * the request profile's bounds, and null when no record exists. */
  /** Verified blob bytes for evidence, refused before any read when the
   * stored length exceeds the caller's bound. */
  async function readBlobBytes(sha256: string, limit: number): Promise<Uint8Array | null> {
    const reader = await services.storage.request(id(), "readBlobTransfer", { sha256 });
    if (reader.byteLength > limit) {
      await services.storage.request(id(), "discardBlobTransfer", { transferId: reader.transferId });
      return null;
    }
    const bytes = new Uint8Array(reader.byteLength);
    try {
      for (;;) {
        const chunk = await services.storage.readChunk(reader.transferId);
        bytes.set(chunk.bytes, chunk.offset);
        await services.storage.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
        if (chunk.final) break;
        if (cancelled || disposed) throw new Error("Generation cancelled before sending.");
      }
    } finally {
      await services.storage.request(id(), "discardBlobTransfer", { transferId: reader.transferId });
    }
    return bytes;
  }
  /** Verified complete thinking blocks for one assistant message's reasoning
   * markers: receipts read through the storage boundary and bound to the
   * message's generation, response and stream records; a message recorded
   * before receipts existed is reconstructed from its retained raw stream.
   * Anything that cannot be verified yields no entry, never a guess. */
  async function verifyReasoning(
    message: Message,
    parts: readonly ContentPart[],
    budget: { receiptBytes: number; rawBytes: number },
  ): Promise<NonNullable<ProviderInput["reasoning"]>> {
    const generation = message.generationId
      ? ((await services.storage.request(id(), "readEntity", { collection: "generations", id: message.generationId })) as unknown as Generation | null)
      : null;
    const model = generation?.model ?? null;
    if (!generation || !model) return {};
    const rawObject = async (rawObjectId: string) =>
      (await services.storage.request(id(), "readEntity", { collection: "rawObjects", id: rawObjectId })) as unknown as RawObject | null;
    const receipts: ThinkingReceipt[] = [];
    let complete = true;
    for (const part of parts) {
      if (part.kind !== "ProviderArtifact" || part.data.providerKind !== THINKING_RECEIPT_KIND) continue;
      const raw = await rawObject(part.data.rawObjectId);
      const limit = Math.min(PROVIDER_LIMITS.reasoningReceiptBytes, budget.receiptBytes);
      const bytes = raw?.availability === "available" && raw.sha256 && raw.byteLength !== null && raw.byteLength <= limit ? await readBlobBytes(raw.sha256, limit) : null;
      if (!bytes) { complete = false; continue; }
      budget.receiptBytes -= bytes.length;
      try { receipts.push(parseThinkingReceipt(bytes)); } catch { complete = false; }
      if (cancelled || disposed) throw new Error("Generation cancelled before sending.");
    }
    if (!receipts.length || !complete) {
      // Bounded reconstruction from the retained raw stream, in part order.
      const segments: Uint8Array[] = [];
      let rebuilt: ThinkingReceipt[] | null = null;
      try {
        for (const part of parts) {
          if (part.kind !== "ProviderArtifact" || part.data.providerKind !== "quixi.provider.raw-stream-chunk") continue;
          const raw = await rawObject(part.data.rawObjectId);
          const bytes = raw?.availability === "available" && raw.sha256 && raw.byteLength !== null && raw.byteLength <= budget.rawBytes ? await readBlobBytes(raw.sha256, budget.rawBytes) : null;
          if (!bytes) throw new Error("Retained stream segment unavailable");
          budget.rawBytes -= bytes.length;
          segments.push(bytes);
          if (cancelled || disposed) throw new Error("Generation cancelled before sending.");
        }
        if (segments.length) rebuilt = reconstructThinkingReceipts(segments, { generationId: generation.id, outputMessageId: message.id, model });
      } catch (error) {
        if (error instanceof Error && error.message === "Generation cancelled before sending.") throw error;
        rebuilt = null;
      }
      if (!rebuilt) return {};
      receipts.splice(0, receipts.length, ...rebuilt);
    }
    return bindReasoningEvidence({ id: message.id, generationId: generation.id, model }, parts, receipts).reasoning;
  }
  async function attachmentBytes(
    attachmentId: string,
    kind: "Image" | "File" | "Audio",
    remainingBytes: number,
  ): Promise<{ attachment: Attachment; bytes: Uint8Array | null } | null> {
    const retained = (await services.storage.request(id(), "readEntity", {
      collection: "attachments",
      id: attachmentId,
    })) as unknown as Attachment | null;
    if (!retained) return null;
    // Normalize request metadata without mutating the retained canonical record.
    const attachment = kind === "Audio" && retained.mimeType
      ? { ...retained, mimeType: normalizeAudioMediaType(retained.mimeType) ?? retained.mimeType }
      : retained;
    if (
      attachment.availability !== "available" ||
      !attachment.blobSha256 ||
      attachment.sizeBytes === null ||
      !attachment.mimeType ||
      !(kind === "Image" ? IMAGE_MEDIA_TYPES : kind === "Audio" ? AUDIO_MEDIA_TYPES : FILE_MEDIA_TYPES).includes(attachment.mimeType) ||
      !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes <= 0 ||
      attachment.sizeBytes > (kind === "Image" ? PROVIDER_LIMITS.imageBytes : kind === "Audio" ? PROVIDER_LIMITS.audioBytes : PROVIDER_LIMITS.fileBytes)
    )
      return { attachment, bytes: null };
    if (attachment.sizeBytes > remainingBytes)
      throw new Error("This branch’s attachments exceed the 2.5 MiB request limit. Exclude an attachment or choose a shorter branch before sending.");
    if (cancelled || disposed) throw new Error("Generation cancelled before sending.");
    const reader = await services.storage.request(id(), "readBlobTransfer", {
      sha256: attachment.blobSha256,
    });
    const bytes = new Uint8Array(attachment.sizeBytes);
    let written = 0, sequence = 0;
    try {
      if (reader.byteLength !== attachment.sizeBytes)
        throw new Error("Attachment size differs from its canonical reference.");
      for (;;) {
        if (cancelled || disposed) throw new Error("Generation cancelled before sending.");
        const chunk = await services.storage.readChunk(reader.transferId);
        if (chunk.transferId !== reader.transferId || chunk.sequence !== sequence++ ||
          chunk.offset !== written || written + chunk.bytes.length > bytes.length || (!chunk.final && !chunk.bytes.length))
          throw new Error("Attachment bytes differ from their canonical size or sequence.");
        bytes.set(chunk.bytes, written);
        written += chunk.bytes.length;
        await services.storage.acknowledgeChunk({
          transferId: chunk.transferId,
          sequence: chunk.sequence,
          committedOffset: written,
        });
        if (chunk.final) break;
        if (cancelled || disposed)
          throw new Error("Generation cancelled before sending.");
      }
    } finally {
      await services.storage.request(id(), "discardBlobTransfer", {
        transferId: reader.transferId,
      });
    }
    if (written !== bytes.length)
      throw new Error("Attachment bytes ended before their canonical size.");
    return { attachment, bytes };
  }
  async function context(
    threadId: string,
    leaf: string | null,
    snapshot: ContextSnapshot,
  ): Promise<{
    messages: ProviderInput["messages"];
    attachments: Record<string, ProviderAttachment>;
    attachmentByteLength: number;
    /** Verified complete thinking blocks keyed by reasoning marker, for the
     * target-specific shaping every request applies. */
    reasoning: NonNullable<ProviderInput["reasoning"]>;
    /** Parts the request never carries or carries transformed, decided here
     * before the adapter maps anything. */
    omitted: { internalProvenance: number; emptyAssistant: number };
    transformed: Transformations;
  }> {
    if (snapshot.compaction) assertAttachmentCompaction(snapshot.compaction);
    const excluded = new Set(snapshot.compaction?.excludedPartIds ?? []);
    const summary = contextSummary(snapshot);
    let foundSummaryBoundary = !summary;
    const messages: Message[] = [];
    let cursor: string | null = null;
    if (leaf)
      do {
        const result: ViewPage<Message> = await services.storage.request(
          id(),
          "readConversationWindow",
          { threadId, leafMessageId: leaf, page: { ...page, cursor } },
        );
        // Windows are chronological within each page and arrive newest first.
        // Find the cutoff using message metadata before reading any parts or
        // bytes: even a huge or unavailable covered attachment stays unread.
        const boundary = summary
          ? result.items.findIndex((message) => message.id === summary.throughMessageId)
          : -1;
        if (boundary >= 0) {
          messages.unshift(...result.items.slice(boundary + 1));
          foundSummaryBoundary = true;
          cursor = null;
        } else {
          messages.unshift(...result.items);
          cursor = result.nextCursor;
        }
        if (messages.length + (summary ? 1 : 0) > 2047)
          throw new Error(
            "This branch exceeds the current request message limit. Choose a shorter branch before sending.",
          );
        if (cancelled || disposed)
          throw new Error("Generation cancelled before sending.");
      } while (cursor);
    if (!foundSummaryBoundary)
      throw new Error(
        "This branch does not include the reviewed summary boundary. Clear the summary or select a branch after its cutoff before continuing.",
      );
    const output: { role: Message["role"]; parts: ContentPart[] }[] = [];
    const attachments: Record<string, ProviderAttachment> = {};
    let bytes = 0,
      attachmentByteLength = 0;
    const omitted = { internalProvenance: 0, emptyAssistant: 0 };
    const transformed: Transformations = { inlinedBlobText: 0, unavailableImages: 0 };
    const reasoning: NonNullable<ProviderInput["reasoning"]> = {};
    const evidenceBudget = { receiptBytes: PROVIDER_LIMITS.reasoningTotalBytes + PROVIDER_LIMITS.reasoningReceiptBytes, rawBytes: PROVIDER_LIMITS.reasoningReconstructionBytes };
    if (summary) {
      const part: ContentPart = {
        id: summary.proposalId,
        messageId: summary.throughMessageId,
        order: 0,
        kind: "Text",
        data: { text: SUMMARY_LABEL + summary.reviewedText },
      };
      bytes += jsonByteLength(part, 2_000_000);
      output.push({ role: "user", parts: [part] });
      transformed.reviewedSummary = true;
    }
    for (const message of messages) {
      if (!message.sealed)
        throw new Error(
          "Wait for the current response to finish before continuing this branch.",
        );
      const parts: ContentPart[] = [];
      // Provider records that explain the message but are never request
      // content: raw stream segments, the response manifest and the thinking
      // receipts/locators that verify its reasoning markers.
      const evidence: ContentPart[] = [];
      cursor = null;
      do {
        const result: EntityPage = await services.storage.request(
          id(),
          "readMessageParts",
          { messageId: message.id, page: { ...page, maxItems: 8, cursor } },
        );
        for (const original of result.items as unknown as ContentPart[]) {
          if (isInternalProvenancePart(original) || isReasoningEvidencePart(original)) {
            omitted.internalProvenance++;
            evidence.push(original);
            continue;
          }
          let part = compactAttachment(original, excluded);
          if (part !== original) transformed.excludedAttachments = (transformed.excludedAttachments ?? 0) + 1;
          // Citations, structured output and this generation's raw-only
          // artifacts are transformed or dropped here, target-independently,
          // with the count the switch report and portability name.
          const degraded = transformOutputPart(part);
          if (degraded.transformation) {
            transformed[degraded.transformation] = (transformed[degraded.transformation] ?? 0) + 1;
            if (!degraded.part) continue;
            part = degraded.part;
          }
          if (
            (part.kind === "Text" || part.kind === "Note") &&
            part.data.textBlob
          ) {
            const blob = part.data.textBlob;
            if (bytes + blob.byteLength > 2_000_000)
              throw new Error(
                "This branch exceeds the current request byte limit. Choose a shorter branch before sending.",
              );
            const reader = await services.storage.request(
              id(),
              "readBlobTransfer",
              { sha256: blob.sha256 },
            );
            let text = "";
            const decoder = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            });
            try {
              for (;;) {
                const chunk = await services.storage.readChunk(
                  reader.transferId,
                );
                text += decoder.decode(chunk.bytes, { stream: !chunk.final });
                await services.storage.acknowledgeChunk({
                  transferId: chunk.transferId,
                  sequence: chunk.sequence,
                  committedOffset: chunk.offset + chunk.bytes.length,
                });
                if (chunk.final) break;
                if (cancelled || disposed)
                  throw new Error("Generation cancelled before sending.");
              }
            } finally {
              await services.storage.request(id(), "discardBlobTransfer", {
                transferId: reader.transferId,
              });
            }
            part = { ...part, data: { text } };
            transformed.inlinedBlobText++;
          }
          if (
            (part.kind === "Image" || part.kind === "File" || part.kind === "Audio") &&
            message.role === "user" &&
            !attachments[part.data.attachmentId]
          ) {
            const image = await attachmentBytes(part.data.attachmentId, part.kind, PROVIDER_LIMITS.attachmentBytes - attachmentByteLength);
            if (image?.bytes) {
              attachmentByteLength += image.bytes.length;
              attachments[part.data.attachmentId] = {
                mediaType: image.attachment.mimeType!,
                bytes: image.bytes,
                ...(image.attachment.filename ? { filename: image.attachment.filename } : {}),
              };
            } else if (part.kind === "Image") {
              // An image whose bytes this device does not hold (an import
              // without its files, a missing blob, or one outside the request
              // profile) is sent as a note naming it, so the conversation can
              // continue; the history keeps the original part.
              const name =
                image?.attachment.filename ??
                part.data.description ??
                "unnamed image";
              part = {
                id: part.id,
                messageId: part.messageId,
                order: part.order,
                kind: "Text",
                data: { text: `[Image not available on this device: ${name}]` },
              };
              transformed.unavailableImages++;
            } else if (image) {
              // Keep known file metadata available to the compatibility
              // mapper even when this request cannot load its bytes. An
              // unsupported MIME type must not masquerade as a missing PDF.
              attachments[part.data.attachmentId] = {
                mediaType: image.attachment.mimeType ?? "application/octet-stream",
                bytes: new Uint8Array(),
                ...(image.attachment.filename ? { filename: image.attachment.filename } : {}),
              };
            }
          }
          bytes += jsonByteLength(part, 2_000_000 - bytes);
          if (bytes > 2_000_000)
            throw new Error(
              "This branch exceeds the current request byte limit. Choose a shorter branch before sending.",
            );
          parts.push(part);
        }
        cursor = result.nextCursor;
        if (cancelled || disposed)
          throw new Error("Generation cancelled before sending.");
      } while (cursor);
      // A failed or cancelled attempt can leave an assistant message with no
      // content on the branch. History keeps it; the request omits it, since
      // providers refuse empty turns and it adds nothing to the conversation.
      if (!parts.length && message.role === "assistant") {
        omitted.emptyAssistant++;
        continue;
      }
      if (message.role === "assistant" && parts.some((part) => part.kind === "ReasoningMetadata"))
        Object.assign(reasoning, await verifyReasoning(message, [...parts, ...evidence], evidenceBudget));
      output.push({ role: message.role, parts });
    }
    return { messages: output, attachments, attachmentByteLength, reasoning, omitted, transformed };
  }
  /** The selected path of one conversation analysed against every configured
   * target's reviewed models, up to the portability target bound. */
  async function inspectPath(
    threadId: string,
    leaf: string,
    snapshot: ContextSnapshot,
    providers: readonly ConfiguredProvider[],
    parameters: GenerationSettings,
  ): Promise<PortabilityInspection> {
    const prior = await context(threadId, leaf, snapshot);
    const targets: PortabilityInspection["targets"] = [];
    for (const provider of providers)
      for (const model of provider.models) {
        if (targets.length >= PORTABILITY_TARGET_LIMIT) break;
        const shaped = shapeReasoningForTarget({
          requestId: id(),
          modelId: model.id,
          systemPrompt: snapshot.systemPrompt,
          messages: prior.messages,
          parameters: requestParameters(parameters),
          reasoning: prior.reasoning,
          ...(Object.keys(prior.attachments).length
            ? { attachments: prior.attachments }
            : {}),
        }, { protocol: provider.adapter.protocol, modelId: model.id });
        targets.push({
          provider: { id: provider.id, label: provider.label },
          model: { id: model.id, name: model.name },
          report: provider.adapter.analyze(shaped.input),
          ...(Object.keys(shaped.transformed).length ? { transformed: withReasoningShape(prior.transformed, shaped) } : {}),
        });
      }
    return {
      leaf,
      empty: !prior.messages.length,
      targets,
      transformed: prior.transformed,
      neverSent: prior.omitted,
    };
  }
  async function attempt(
    provider: ConfiguredProvider,
    modelId: string,
    threadId: string,
    parent: Message,
    input: ProviderInput,
    contextId: string,
    revision: number,
    createWith?: (generationId: string) => CanonicalMutation[],
    originatingRequirements: RoutingRequirements = {},
  ): Promise<AttemptOutcome> {
    const view = await services.storage.request(id(), "readThreadView", {
      threadId,
    });
    if (view.state.revision !== revision)
      throw new Error(
        "This conversation changed. Review the selected branch before starting a new attempt.",
      );
    if (view.context.id !== contextId)
      throw new Error(
        "The system prompt changed. Review it before starting a new attempt.",
      );
    const requirements = routingRequirements(view.state.routingProfile);
    const originalRegion = requireRegion(provider, modelId, originatingRequirements);
    const region = requireRegion(provider, modelId, requirements);
    const connectionRegion = provider.regionalProcessing ? requireRegion(provider, modelId, { processingRegion: provider.regionalProcessing.region }) : null;
    const evidence = processingRegionKey(provider);
    provider.adapter.prepare(input);
    const now = Date.now(),
      generationId = id(),
      outputId = id();
    const generation: Generation = {
      id: generationId,
      threadId,
      parentMessageId: parent.id,
      outputMessageId: outputId,
      contextSnapshotId: view.context.id,
      provider: provider.adapter.binding.providerId,
      providerAccountId: provider.adapter.binding.accountId,
      model: modelId,
      parameters: {},
      status: "streaming",
      createdAt: now,
      recordedAt: now,
      completedAt: null,
      tokensIn: null,
      tokensOut: null,
      cachedTokens: null,
      estimatedCost: null,
      reportedCost: null,
      lastSequence: 0,
      rawResponseId: null,
      compatibility: [...new Set([originalRegion, region, ...(connectionRegion ? [connectionRegion] : [])].filter(value => value.basis !== null).map(value => value.reason))],
    };
    const output: Message = {
      id: outputId,
      threadId,
      parentId: parent.id,
      role: "assistant",
      createdAt: now,
      recordedAt: now,
      generationId,
      editedFromMessageId: null,
      partCount: 0,
      sealed: false,
    };
    if (cancelled || disposed)
      throw new Error("Generation cancelled before sending.");
    run = await startCoordinatedGeneration({
      archiveId: services.archiveId,
      adapter: provider.adapter,
      input,
      storage: services.storage,
      attempt: { generation, output },
      initialThreadRevision: view.state.revision,
      beforeDispatch: () => beforeRegionDispatch(provider, input, threadId, contextId, originatingRequirements, evidence, { profile: JSON.stringify(view.state.routingProfile) }),
      nextId: id,
      now: () => Date.now(),
      ...(createWith ? { createWith } : {}),
      async onCreated() {
        if (cancelled || disposed)
          throw new Error("Generation cancelled before sending.");
        await library.commit(
          [library.mutation("SetActiveBranch", { threadId, value: outputId })],
          { threadId, revision: view.state.revision },
        );
        if (library.getSnapshot().thread?.thread.id === threadId)
          await library.loadView(threadId, outputId);
      },
    });
    if (cancelled || disposed) await run.cancel();
    const result = await run.result;
    if (library.getSnapshot().thread?.thread.id === threadId)
      await library.loadView(threadId, outputId);
    if (!result.persisted || result.error)
      throw new Error(
        result.error?.message ??
          "The response could not be fully saved. Its committed text is retained.",
      );
    return {
      generationId,
      outputId,
      status: result.terminal?.status ?? "failed",
      failure: result.terminal?.error
        ? { code: result.terminal.error.code, message: result.terminal.error.message }
        : null,
    };
  }
  /** The AutomaticFallback event a routed first attempt is created with:
   * the selected connection was not tried, for the recorded reason. */
  function routedEvent(
    routed: RoutedAttempt,
    provider: ConfiguredProvider,
    modelId: string,
    threadId: string,
    messageId: string,
  ): (generationId: string) => CanonicalMutation[] {
    return (generationId) => {
      const now = Date.now();
      return [
        library.mutation("CreateThreadEvent", {
          event: {
            id: id(),
            threadId,
            type: "AutomaticFallback",
            createdAt: now,
            recordedAt: now,
            messageId,
            generationId,
            details: {
              from: routed.from,
              to: { provider: provider.id, model: modelId, privacy: provider.privacy ?? null },
              primaryGenerationId: null,
              primaryStatus: "not_attempted",
              failureCode: null,
              reason: routed.reason,
            },
          },
        }),
      ];
    };
  }
  /** After a primary attempt that did not complete, continue with the
   * conversation's fallback target as a separate attempt when the policy
   * allows it, recording the fallback with that attempt; otherwise say why.
   * A user stop never falls back. */
  async function fallbackAfter(
    outcome: AttemptOutcome,
    primary: { provider: ConfiguredProvider; modelId: string },
    threadId: string,
    parent: Message,
    /** The request before target shaping, so each candidate receives the
     * reasoning blocks it can read. */
    input: ProviderInput,
    contextId: string,
    plan: FallbackPlan | null,
    requirements: RoutingRequirements,
  ) {
    if (!plan || outcome.status === "complete" || cancelled || disposed) return;
    const view = await services.storage.request(id(), "readThreadView", { threadId });
    const currentRequirements = routingRequirements(view.state.routingProfile);
    const failure: FallbackFailure = {
      status: outcome.status,
      code: outcome.failure?.code ?? null,
      message:
        outcome.failure?.message ??
        `The attempt ended with status ${outcome.status}.`,
    };
    // Candidates are tried in order; the first that qualifies runs, and every
    // refusal before it is reported with its reason.
    const refusals: string[] = [];
    let chosen: {
      configured: ConfiguredProvider;
      model: { id: string; name: string };
      input: ProviderInput;
      reason: string;
    } | null = null;
    for (const candidate of plan.candidates()) {
      const targetInput: ProviderInput | null =
        candidate.configured && candidate.model
          ? shapeReasoningForTarget({ ...input, requestId: id(), modelId: candidate.model.id }, { protocol: candidate.configured.adapter.protocol, modelId: candidate.model.id }).input
          : null;
      const report =
        candidate.configured && targetInput
          ? candidate.configured.adapter.analyze(targetInput)
          : null;
      const decision = evaluateFallback(
        {
          provider: candidate.requested.provider,
          model: candidate.requested.model,
          allowPrivacyChange: plan.allowPrivacyChange,
        },
        {
          label: plan.primaryLabel,
          provider: primary.provider.id,
          model: primary.modelId,
          privacy: plan.primaryPrivacy,
        },
        candidate.configured
          ? {
              provider: {
                id: candidate.configured.id,
                label: candidate.configured.label,
                privacy: candidate.configured.privacy ?? null,
              },
              model: candidate.model,
              health: candidate.health,
            }
          : null,
        failure,
        report,
      );
      if (decision.apply && candidate.configured && candidate.model && targetInput) {
        const region = assessProcessingRegion(requirements, candidate.configured, targetInput.modelId);
        const currentRegion = assessProcessingRegion(currentRequirements, candidate.configured, targetInput.modelId);
        if (!region.allowed || !currentRegion.allowed) { refusals.push(`${candidate.configured.label}: ${!region.allowed ? region.reason : currentRegion.reason}`); continue; }
        const evidence = processingRegionKey(candidate.configured);
        const costs = [await requestCost(candidate.configured, targetInput, requirements)];
        if (JSON.stringify(currentRequirements) !== JSON.stringify(requirements)) costs.push(await requestCost(candidate.configured, targetInput, currentRequirements));
        const denied = costs.find(cost => !cost.allowed);
        if (denied) { refusals.push(`${candidate.configured.label}: ${denied.reason}.`); continue; }
        if (processingRegionKey(candidate.configured) !== evidence) { refusals.push(`${candidate.configured.label}: processing-region evidence changed.`); continue; }
        requireRegion(candidate.configured, targetInput.modelId, requirements);
        requireRegion(candidate.configured, targetInput.modelId, currentRequirements);
        candidate.configured.adapter.prepare(targetInput);
        chosen = {
          configured: candidate.configured,
          model: candidate.model,
          input: targetInput,
          reason: `${decision.reason}${[...new Set([region, currentRegion].filter(value => value.basis !== null).map(value => ` ${value.reason}`))].join('')}${costs.filter(cost => cost.basis !== 'unavailable').map(cost => ` Cost check: ${cost.reason}.`).join('')}`,
        };
        break;
      }
      refusals.push(decision.reason);
      // A user stop refuses every candidate for the same reason.
      if (failure.status === "cancelled" || failure.status === "stopped") break;
    }
    if (!chosen) {
      library.patch({ error: `Fallback was not used. ${refusals.join(" ")}` });
      return;
    }
    const now = Date.now();
    const candidate = chosen;
    const target = candidate.model;
    const targetInput = candidate.input;
    const decision = { reason: candidate.reason };
    await attempt(
      candidate.configured,
      target.id,
      threadId,
      parent,
      targetInput,
      contextId,
      view.state.revision,
      (generationId) => [
        library.mutation("CreateThreadEvent", {
          event: {
            id: id(),
            threadId,
            type: "AutomaticFallback",
            createdAt: now,
            recordedAt: now,
            messageId: parent.id,
            generationId,
            details: {
              from: {
                provider: primary.provider.id,
                model: primary.modelId,
                privacy: plan.primaryPrivacy,
              },
              to: {
                provider: candidate.configured.id,
                model: target.id,
                privacy: candidate.configured.privacy ?? null,
              },
              primaryGenerationId: outcome.generationId,
              primaryStatus: outcome.status,
              failureCode: failure.code,
              reason: decision.reason,
            },
          },
        }),
      ],
      requirements,
    );
  }
  /** The user turn a send would create: text first, then staged attachments. */
  function composeTurn(
    text: string,
    images: readonly ComposerAttachment[],
    prior: Awaited<ReturnType<typeof context>>,
  ) {
    const messageId = id();
    const parts: ContentPart[] = text.trim()
      ? [{ id: id(), messageId, order: 0, kind: "Text", data: { text } }]
      : [];
    const attachments: Attachment[] = images.map((image) => ({
      id: id(),
      availability: "available",
      filename: image.filename,
      mimeType: image.mediaType,
      sizeBytes: image.byteLength,
      blobSha256: image.sha256,
      rawObjectId: null,
    }));
    const requestAttachments = { ...prior.attachments };
    let attachmentByteLength = prior.attachmentByteLength;
    attachments.forEach((attachment, index) => {
      const image = images[index]!;
      if (image.byteLength !== image.bytes.length || !Number.isSafeInteger(image.byteLength) || image.byteLength <= 0)
        throw new Error("Staged attachment bytes differ from their verified size.");
      attachmentByteLength += image.byteLength;
      if (attachmentByteLength > PROVIDER_LIMITS.attachmentBytes)
        throw new Error(
          "This branch’s attachments exceed the 2.5 MiB request limit. Remove or exclude an attachment, or choose a shorter branch before sending.",
        );
      parts.push({
        id: id(),
        messageId,
        order: parts.length,
        kind: image.kind ?? "Image",
        data: { attachmentId: attachment.id, description: image.filename },
      });
      requestAttachments[attachment.id] = {
        mediaType: image.mediaType,
        bytes: image.bytes,
        filename: image.filename,
      };
    });
    return { messageId, parts, attachments, requestAttachments };
  }
  return {
    /** What switching the active path to another connection or model would
     * carry, transform, omit or refuse. Reads the branch; commits nothing. */
    async inspectSwitch(
      provider: ConfiguredProvider,
      modelId: string,
      parameters: GenerationSettings = { maxOutputTokens: 1024 },
      draftAttachments: readonly ComposerAttachment[] = [],
    ): Promise<SwitchInspection | null> {
      if (busy || disposed) return null;
      // A stop applies to the run it interrupted; nothing is in flight here.
      cancelled = false;
      const current = library.getSnapshot();
      if (!current.thread || !current.leaf) return null;
      const prior = await context(current.thread.thread.id, current.leaf, current.thread.context);
      if (!prior.messages.length) return null;
      const turn = draftAttachments.length ? composeTurn("", draftAttachments, prior) : null;
      const requestAttachments = turn?.requestAttachments ?? prior.attachments;
      const shaped = shapeReasoningForTarget({
        requestId: id(),
        modelId,
        systemPrompt: current.thread.context.systemPrompt,
        messages: turn ? [...prior.messages, { role: "user", parts: turn.parts }] : prior.messages,
        parameters: requestParameters(parameters),
        reasoning: prior.reasoning,
        ...(Object.keys(requestAttachments).length
          ? { attachments: requestAttachments }
          : {}),
      }, { protocol: provider.adapter.protocol, modelId });
      const report = provider.adapter.analyze(shaped.input);
      return {
        report,
        omitted: { ...prior.omitted, emptyAssistant: prior.omitted.emptyAssistant + shaped.emptyAssistant },
        transformed: withReasoningShape(prior.transformed, shaped),
        leaf: current.leaf,
      };
    },
    /** The active path analysed against every configured connection's
     * reviewed models, bounded, for the portability status. Reads the branch
     * once; commits nothing; never contacts a provider. */
    async assessPortability(
      providers: readonly ConfiguredProvider[],
      parameters: GenerationSettings = { maxOutputTokens: 1024 },
    ): Promise<PortabilityInspection | null> {
      if (busy || disposed) return null;
      cancelled = false;
      const current = library.getSnapshot();
      if (!current.thread || !current.leaf) return null;
      return inspectPath(current.thread.thread.id, current.leaf, current.thread.context, providers, parameters);
    },
    /** Plan 12 bulk analysis: the same inspection for any conversation's
     * selected path, read from storage rather than the open conversation.
     * Null while a generation is in progress (the workflow is busy) or when
     * the conversation has no selected message yet. */
    async assessThreadPortability(
      threadId: string,
      providers: readonly ConfiguredProvider[],
      parameters: GenerationSettings = { maxOutputTokens: 1024 },
    ): Promise<PortabilityInspection | null | "busy"> {
      if (busy || disposed) return "busy";
      cancelled = false;
      const view = await services.storage.request(id(), "readThreadView", { threadId });
      if (!view.state.activeLeafMessageId) return null;
      return inspectPath(threadId, view.state.activeLeafMessageId, view.context, providers, parameters);
    },
    /** Count the prompt a send would dispatch, through the provider's own
     * counting implementation when available. Nothing is committed. */
    async countPrompt(
      text: string,
      provider: ConfiguredProvider,
      modelId: string,
      parameters: GenerationSettings = { maxOutputTokens: 1024 },
      images: readonly ComposerAttachment[] = [],
    ): Promise<{ tokens: number | null; source: "provider" | "unavailable"; reason: string | null } | null> {
      if (busy || disposed) return null;
      cancelled = false;
      const current = library.getSnapshot();
      if (current.busy || current.pendingMutation || !current.thread || (!text.trim() && !images.length) || text.length > 16_384)
        return null;
      const requirements = routingRequirements(current.thread.state.routingProfile);
      requireRegion(provider, modelId, requirements);
      const evidence = processingRegionKey(provider), profileScope = JSON.stringify(current.thread.state.routingProfile);
      const prior = await context(current.thread.thread.id, current.leaf, current.thread.context);
      const turn = composeTurn(text, images, prior);
      const input: ProviderInput = shapeReasoningForTarget({
        requestId: id(),
        modelId,
        systemPrompt: current.thread.context.systemPrompt,
        messages: [...prior.messages, { role: "user", parts: turn.parts }],
        parameters: requestParameters(parameters),
        reasoning: prior.reasoning,
        ...(Object.keys(turn.requestAttachments).length
          ? { attachments: turn.requestAttachments }
          : {}),
      }, { protocol: provider.adapter.protocol, modelId }).input;
      const latest = library.getSnapshot();
      if (latest.busy || latest.pendingMutation || latest.leaf !== current.leaf || latest.thread?.thread.id !== current.thread.thread.id ||
        latest.thread?.state.revision !== current.thread.state.revision || latest.thread?.context.id !== current.thread.context.id) return null;
      requireRegion(provider, modelId, requirements);
      const digest = requirements.maxRequestCost !== undefined || requirements.maxEstimatedRequestCost !== undefined ? await requestDigest(provider, input) : null;
      const sameCountScope = () => { const value = library.getSnapshot(); return !disposed && !cancelled && !value.busy && !value.pendingMutation && value.leaf === current.leaf && value.thread?.thread.id === current.thread!.thread.id && value.thread?.state.revision === current.thread!.state.revision && value.thread?.context.id === current.thread!.context.id && JSON.stringify(value.thread?.state.routingProfile) === profileScope && processingRegionKey(provider) === evidence; };
      if (!sameCountScope()) return null;
      const result = await provider.adapter.countTokens(input, async () => {
        if (!sameCountScope()) throw new Error('The conversation changed before counting.');
        await beforeRegionDispatch(provider, input, current.thread!.thread.id, current.thread!.context.id, requirements, evidence, { profile: profileScope, revision: current.thread!.state.revision });
        if (!sameCountScope()) throw new Error('The conversation changed before counting.');
      });
      if (!sameCountScope()) return null;
      const countedView = await services.storage.request(id(), 'readThreadView', { threadId: current.thread.thread.id });
      if (!sameCountScope() || !countedView || countedView.state.revision !== current.thread.state.revision ||
        countedView.context.id !== current.thread.context.id || JSON.stringify(countedView.state.routingProfile) !== profileScope) return null;
      requireRegion(provider, modelId, requirements);
      // Regional eligibility can be revoked while the count is in flight.
      if (provider.regionalProcessing) provider.adapter.prepare(input);
      if (digest && result.tokens !== null && Number.isSafeInteger(result.tokens) && result.tokens >= 0) {
        const previous = promptCounts.findIndex(value => value.adapter === provider.adapter && value.model === input.modelId && value.digest === digest && value.region === processingRegionKey(provider));
        if (previous >= 0) promptCounts.splice(previous, 1);
        promptCounts.push({ adapter: provider.adapter, model: input.modelId, digest, region: evidence, tokens: result.tokens });
        if (promptCounts.length > 16) promptCounts.shift();
      }
      return result;
    },
    async send(
      text: string,
      provider: ConfiguredProvider,
      modelId: string,
      parameters: GenerationSettings = { maxOutputTokens: 1024 },
      images: readonly ComposerAttachment[] = [],
      switching: ProviderSwitch | null = null,
      fallback: FallbackPlan | null = null,
      routed: RoutedAttempt | null = null,
    ): Promise<boolean> {
      if (busy || disposed) return false;
      const current = library.getSnapshot();
      if (
        !current.thread ||
        (!text.trim() && !images.length) ||
        text.length > 16_384
      )
        return false;
      busy = true;
      cancelled = false;
      library.patch({ busy: true, error: null });
      let saved = false;
      try {
        const view = current.thread,
          threadId = view.thread.id,
          parentId = current.leaf;
        const prior = await context(threadId, parentId, view.context);
        const now = Date.now();
        // Text first, then each staged image as a first-class attachment part.
        const { messageId, parts, attachments, requestAttachments } =
          composeTurn(text, images, prior);
        const message: Message = {
          id: messageId,
          threadId,
          parentId,
          role: "user",
          createdAt: now,
          recordedAt: now,
          generationId: null,
          editedFromMessageId: null,
          partCount: parts.length,
          sealed: true,
        };
        const unshaped: ProviderInput = {
          requestId: id(),
          modelId,
          systemPrompt: view.context.systemPrompt,
          messages: [...prior.messages, { role: "user", parts }],
          parameters: requestParameters(parameters),
          reasoning: prior.reasoning,
          ...(Object.keys(requestAttachments).length
            ? { attachments: requestAttachments }
            : {}),
        };
        const input = shapeReasoningForTarget(unshaped, { protocol: provider.adapter.protocol, modelId }).input;
        const requirements = routingRequirements(view.state.routingProfile);
        requireRegion(provider, modelId, requirements);
        const evidence = processingRegionKey(provider);
        const cost = await requestCost(provider, input, requirements);
        if (!cost.allowed) throw new Error(`Request cost limit: ${cost.reason}. Count this prompt explicitly for a tighter estimate or review the limit.`);
        if (processingRegionKey(provider) !== evidence) throw new Error('The processing-region evidence changed. Review the connection again.');
        requireRegion(provider, modelId, requirements);
        provider.adapter.prepare(input);
        if (cancelled || disposed)
          throw new Error("Generation cancelled before sending.");
        // A reviewed switch is recorded with the user turn it applies to, in
        // the same commit, so it stays inspectable after reload.
        const switchEvent: ThreadEvent | null = switching
          ? {
              id: id(),
              threadId,
              type: "ProviderSwitch",
              createdAt: now,
              recordedAt: now,
              messageId: message.id,
              generationId: null,
              details: switching as unknown as JsonObject,
            }
          : null;
        await library.commit(
          [
            ...attachments.map((attachment) =>
              library.mutation("RegisterAttachment", { attachment }),
            ),
            library.mutation("CreateMessage", { message, parts }),
            ...(switchEvent
              ? [library.mutation("CreateThreadEvent", { event: switchEvent })]
              : []),
            library.mutation("SetActiveBranch", {
              threadId,
              value: message.id,
            }),
          ],
          { threadId, revision: view.state.revision },
          images.map((image) => image.transferId),
        );
        saved = true;
        if (library.getSnapshot().thread?.thread.id === threadId)
          await library.loadView(threadId, message.id);
        const outcome = await attempt(
          provider,
          modelId,
          threadId,
          message,
          input,
          view.context.id,
          view.state.revision + 1,
          routed ? routedEvent(routed, provider, modelId, threadId, message.id) : undefined,
          requirements,
        );
        await fallbackAfter(
          outcome,
          { provider, modelId },
          threadId,
          message,
          unshaped,
          view.context.id,
          fallback,
          requirements,
        );
      } catch (error) {
        library.patch({
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        run = null;
        busy = false;
        library.patch({ busy: false });
      }
      return saved;
    },
    async regenerate(
      parent: Message,
      provider: ConfiguredProvider,
      modelId: string,
      parameters: GenerationSettings = { maxOutputTokens: 1024 },
      fallback: FallbackPlan | null = null,
      routed: RoutedAttempt | null = null,
    ) {
      if (busy || disposed || !parent.sealed) return;
      busy = true;
      cancelled = false;
      library.patch({ busy: true, error: null });
      try {
        const view = await services.storage.request(id(), "readThreadView", {
          threadId: parent.threadId,
        });
        const prior = await context(parent.threadId, parent.id, view.context);
        const unshaped: ProviderInput = {
          requestId: id(),
          modelId,
          systemPrompt: view.context.systemPrompt,
          messages: prior.messages,
          parameters: requestParameters(parameters),
          reasoning: prior.reasoning,
          ...(Object.keys(prior.attachments).length
            ? { attachments: prior.attachments }
            : {}),
        };
        const input = shapeReasoningForTarget(unshaped, { protocol: provider.adapter.protocol, modelId }).input;
        const requirements = routingRequirements(view.state.routingProfile);
        requireRegion(provider, modelId, requirements);
        const evidence = processingRegionKey(provider);
        const cost = await requestCost(provider, input, requirements);
        if (!cost.allowed) throw new Error(`Request cost limit: ${cost.reason}. Review the limit before generating; no matching count is available for this request.`);
        if (processingRegionKey(provider) !== evidence) throw new Error('The processing-region evidence changed. Review the connection again.');
        requireRegion(provider, modelId, requirements);
        provider.adapter.prepare(input);
        const outcome = await attempt(
          provider,
          modelId,
          parent.threadId,
          parent,
          input,
          view.context.id,
          view.state.revision,
          routed ? routedEvent(routed, provider, modelId, parent.threadId, parent.id) : undefined,
          requirements,
        );
        await fallbackAfter(
          outcome,
          { provider, modelId },
          parent.threadId,
          parent,
          unshaped,
          view.context.id,
          fallback,
          requirements,
        );
      } catch (error) {
        library.patch({
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        run = null;
        busy = false;
        library.patch({ busy: false });
      }
    },
    async stop() {
      cancelled = true;
      await run?.cancel();
    },
    async dispose() {
      disposed = true;
      cancelled = true;
      promptCounts.length = 0;
      await run?.cancel();
    },
  };
}
