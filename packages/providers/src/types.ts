import type {
  ContentPart,
  Cost,
  JsonObject,
  JsonValue,
  QuixiId,
  Role,
} from "@quixi/core/model";
import type {
  HostCancellationResult,
  HostClient,
  ProviderBinding,
  SecretHandle,
} from "@quixi/core/contracts";
export type Protocol = "openai-compatible" | "anthropic";
export type Support = "supported" | "unsupported" | "unknown";
export interface ModelCapabilities {
  inputModalities: readonly ("text" | "image" | "audio" | "file")[];
  outputModalities: readonly ("text" | "image" | "audio")[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  streaming: Support;
  tools: Support;
  reasoning: Support;
  /** Exact implemented continuation/configuration profile, never inferred from reasoning support alone. */
  thinkingProfile?: "anthropic-manual-haiku-4.5";
  structuredOutput: Support;
  images: Support;
  files: Support;
  /** Exact reviewed file MIME types; absent means no reviewed file support. */
  fileMediaTypes?: readonly string[];
  /** Exact reviewed audio MIME types; absent means no reviewed audio support. */
  audioMediaTypes?: readonly string[];
  webSearch: Support;
  imageGeneration: Support;
  systemPromptMode:
    "system" | "developer" | "top_level" | "unsupported" | "unknown";
  parameters: readonly (
    "maxOutputTokens" | "temperature" | "topP" | "stopSequences" | "thinkingBudgetTokens"
  )[];
}
export interface Pricing {
  currency: string;
  inputPerMillion: string;
  outputPerMillion: string;
  cachedInputPerMillion: string | null;
  cacheWriteInputPerMillion: string | null;
  sourceUrl: string;
  verifiedAt: number;
}
export interface ModelDescription {
  id: string;
  name: string;
  protocol: Protocol;
  capabilities: ModelCapabilities;
  pricing: Pricing | null;
  provenance: {
    source: "operator_catalog" | "provider_list";
    sourceUrl: string | null;
    observedAt: number;
  };
  raw: JsonObject | null;
}
export type HealthStatus =
  | "healthy"
  | "rate_limited"
  | "authentication_expired"
  | "provider_degraded"
  | "region_unavailable"
  | "offline"
  | "unknown";
export interface AccountHealth {
  status: HealthStatus;
  observedAt: number;
  retryAt: number | null;
  reason: string | null;
  evidence: "models_probe" | "generation" | "transport" | "none";
}
export interface ProviderAccountDescription {
  binding: ProviderBinding;
  label: string | null;
  credentialPersistence: SecretHandle["persistence"] | null;
  health: AccountHealth;
}
export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningTokens: number | null;
  raw: JsonObject;
  source: "provider";
}
export interface ProviderFailure {
  code:
    | "authentication"
    | "permission"
    | "rate_limit"
    | "region_unavailable"
    | "provider_error"
    | "invalid_request"
    | "transport"
    | "protocol"
    | "limit"
    | "unsupported";
  message: string;
  status: number | null;
  providerCode: string | null;
  retryAfterMs: number | null;
  retry: "manual_new_attempt" | "after_user_action" | "never";
}
export type OutputPart = ContentPart extends infer P
  ? P extends ContentPart
    ? Omit<P, "id" | "messageId" | "order">
    : never
  : never;
export type ProviderEvent =
  | { type: "raw"; sequence: number; bytes: Uint8Array }
  | {
      type: "metadata";
      responseId: string | null;
      model: string | null;
      headers: Record<string, string>;
    }
  | { type: "text"; key: string; text: string }
  | { type: "part"; key: string; part: OutputPart }
  | { type: "artifact"; key: string; providerKind: string; locator: string }
  /** A fully closed provider block, never a display summary or partial delta. */
  | { type: "reasoning_block"; index: number; startRecord: number; endRecord: number;
      block: { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string } }
  | { type: "usage"; usage: ProviderUsage }
  | {
      type: "terminal";
      status: "complete" | "stopped" | "failed" | "cancelled" | "partial";
      stopReason: string | null;
      responseId: string | null;
      usage: ProviderUsage;
      error: ProviderFailure | null;
    };
/** Bytes for an Image, File or Audio part, supplied by the caller from verified attachment
 * storage. The adapter never reads storage itself. */
export interface ProviderAttachment {
  /** Plain display filename; omitted PDF names default to attachment.pdf. */
  filename?: string;
  mediaType: string;
  /** Empty bytes may carry known historical metadata for an inspect refusal;
   * supported files still require nonempty verified bytes before count/send. */
  bytes: Uint8Array;
}
export interface ProviderInput {
  requestId: QuixiId;
  modelId: string;
  systemPrompt: string | null;
  messages: readonly { role: Role; parts: readonly ContentPart[] }[];
  /** Keyed by attachment ID. Missing entries surface as compatibility issues. */
  attachments?: Readonly<Record<string, ProviderAttachment>>;
  /** Complete blocks verified by the caller against retained raw stream evidence,
   * keyed by canonical ReasoningMetadata part ID. Display summaries are not evidence. */
  reasoning?: Readonly<Record<string, {
    protocol: "anthropic";
    modelId: string;
    messageId: string;
    index: number;
    block: { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string };
  }>>;
  parameters: {
    maxOutputTokens: number;
    temperature?: number;
    topP?: number;
    stopSequences?: readonly string[];
    thinkingBudgetTokens?: number;
  };
  tools?: readonly {
    name: string;
    description: string;
    inputSchema: JsonObject;
  }[];
}
export interface CompatibilityIssue {
  messageIndex: number | null;
  partId: string | null;
  code: string;
  message: string;
}
/** What the request mapper would do with an active path for a target model:
 * parts it carries as provider blocks, parts it refuses, and request-level
 * constraints. Omissions decided before mapping (internal provenance,
 * empty responses, inlined blob text) are the caller's to add. */
export interface CompatibilityReport {
  target: { protocol: Protocol; modelId: string };
  preserved: { parts: number; byKind: Partial<Record<ContentPart["kind"], number>> };
  blocked: { partId: string | null; kind: ContentPart["kind"] | null; code: string; message: string }[];
  constraints: CompatibilityIssue[];
  requestBytes: number | null;
  sendable: boolean;
  /** The target's catalog context window, the requested output, and the room
   * left for input (window minus output; null without a window). Token counts
   * are not part of the report: counting sends the branch to the provider. */
  context: { contextWindow: number | null; maxOutputTokens: number; inputRoom: number | null };
  /** The target's reviewed price, when the catalog has one. */
  pricing: Pricing | null;
}
export interface PreparedRequest {
  requestId: QuixiId;
  model: ModelDescription;
  path: string;
  headers: Record<string, string>;
  body: JsonObject;
}
export interface ProviderStream {
  events: AsyncIterable<ProviderEvent>;
  cancel(): Promise<HostCancellationResult>;
}
export interface ProviderOptions {
  host: HostClient;
  binding: ProviderBinding;
  credential: SecretHandle | null;
  accountLabel?: string;
  catalog: readonly ModelDescription[];
  nextId(): QuixiId;
  now(): number;
}
export interface ProviderAdapter {
  readonly protocol: Protocol;
  readonly binding: ProviderBinding;
  describeAccount(): ProviderAccountDescription;
  describeModel(id: string): ModelDescription | null;
  capabilities(id: string): ModelCapabilities | null;
  authenticate(signal?: AbortSignal): Promise<AccountHealth>;
  /** One page of the provider's model list. Anthropic pages by `after_id`
   * with the maximum page size; pass `nextCursor` for the next page. The
   * OpenAI list has no pagination, so a page is the whole listing. */
  listModels(cursor?: string | null, signal?: AbortSignal): Promise<{
    models: ModelDescription[];
    complete: boolean;
    nextCursor: string | null;
  }>;
  prepare(input: ProviderInput): PreparedRequest;
  /** The report `prepare` would act on, without throwing. */
  analyze(input: ProviderInput): CompatibilityReport;
  /** Recheck mutable authorization after body staging, immediately before HTTP. */
  stream(input: ProviderInput, beforeDispatch?: () => Promise<void>): ProviderStream;
  accountHealth(): AccountHealth;
  /** Anthropic counts the prepared prompt through POST /v1/messages/count_tokens
   * (generation-only fields dropped); the OpenAI-compatible Chat Completions profile
   * does not implement counting and reports unavailable. */
  countTokens(
    input: ProviderInput,
    beforeDispatch?: () => Promise<void>,
  ): Promise<{
    tokens: number | null;
    source: "provider" | "unavailable";
    reason: string | null;
  }>;
  estimateCost(
    modelId: string,
    usage: ProviderUsage,
  ): { cost: Cost | null; pricing: Pricing | null; reason: string | null };
}
export class CompatibilityError extends Error {
  readonly code = "UNSUPPORTED";
  constructor(readonly issues: CompatibilityIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
  }
}
export class StreamFailure extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.message);
  }
}
export const IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export const AUDIO_MEDIA_TYPES: readonly string[] = Object.freeze(["audio/wav", "audio/mpeg"]);
/** Normalize historical MIME labels only; byte/container validation belongs to
 * staging. A filename or generic binary MIME never establishes audio format. */
export function normalizeAudioMediaType(value: string): string | null {
  const essence = value.split(";", 1)[0]!.trim().toLowerCase();
  if (["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"].includes(essence)) return "audio/wav";
  if (["audio/mpeg", "audio/mp3", "audio/x-mp3", "audio/x-mpeg", "audio/mpeg3", "audio/x-mpeg-3"].includes(essence)) return "audio/mpeg";
  return null;
}
export const FILE_MEDIA_TYPES: readonly string[] = Object.freeze(["application/pdf"]);
export const LIMITS = Object.freeze({
  requestBytes: 4 * 1024 * 1024,
  /** Raw image bytes per attachment; base64 expansion is counted against requestBytes. */
  imageBytes: 2_621_440,
  imagesPerRequest: 20,
  fileBytes: 2_621_440,
  filesPerRequest: 20,
  audioBytes: 2_621_440,
  audioPerRequest: 20,
  /** Sum of raw bytes for all image/file/audio occurrences before base64 allocation. */
  attachmentBytes: 2_621_440,
  eventBytes: 256 * 1024,
  streamBytes: 64 * 1024 * 1024,
  toolBytes: 256 * 1024,
  toolTotalBytes: 1024 * 1024,
  reasoningBlockBytes: 256 * 1024,
  reasoningTotalBytes: 1024 * 1024,
  /** One version-1 thinking receipt: the block plus its provenance envelope. */
  reasoningReceiptBytes: 272 * 1024,
  /** Retained raw stream bytes replayed to reconstruct receipts a generation
   * recorded before receipts existed. */
  reasoningReconstructionBytes: 8 * 1024 * 1024,
  /** Anthropic's documented manual-thinking minimum (read 2026-09-11). */
  thinkingBudgetMin: 1024,
  parts: 4096,
  models: 2048,
  /** Anthropic's documented maximum `limit` for GET /v1/models. */
  modelPageSize: 1000,
  /** Pages a discovery pass follows before reporting the listing incomplete. */
  modelPages: 8,
  modelResponseBytes: 1024 * 1024,
});
export const unknownCapabilities: ModelCapabilities = Object.freeze({
  inputModalities: [],
  outputModalities: [],
  contextWindow: null,
  maxOutputTokens: null,
  streaming: "unknown",
  tools: "unknown",
  reasoning: "unknown",
  structuredOutput: "unknown",
  images: "unknown",
  files: "unknown",
  webSearch: "unknown",
  imageGeneration: "unknown",
  systemPromptMode: "unknown",
  parameters: [],
});
export const emptyUsage = (): ProviderUsage => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  reasoningTokens: null,
  raw: {},
  source: "provider",
});
export function protocolFailure(
  message: string,
  code: ProviderFailure["code"] = "protocol",
): StreamFailure {
  return new StreamFailure({
    code,
    message,
    status: null,
    providerCode: null,
    retryAfterMs: null,
    retry: "manual_new_attempt",
  });
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw protocolFailure("Provider returned an invalid object.");
  return value as JsonObject;
}
export function string(
  value: JsonValue | undefined,
  max = 4096,
): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}
export function count(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
