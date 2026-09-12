import { SUMMARY_LIMITS, utf8ByteLength } from '@quixi/core/model';
import type {
  CanonicalMutation,
  HostCancellationResult,
  MutationBatch,
  StorageClient,
} from "@quixi/core/contracts";
import type {
  ContentPart,
  Generation,
  JsonObject,
  Message,
  RawObject,
} from "@quixi/core/model";
import {
  CompatibilityError,
  emptyUsage,
  LIMITS,
  type OutputPart,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderInput,
  type ProviderStream,
} from "./types.ts";
import { jsonByteLength } from "@quixi/core/contracts";
type Terminal = Extract<ProviderEvent, { type: "terminal" }>;
export interface GenerationRunOptions {
  adapter: ProviderAdapter;
  input: ProviderInput;
  storage: StorageClient;
  /** Fresh IDs, a sealed parent and an existing context are required. */
  attempt: { generation: Generation; output: Message };
  /** Guard only attempt creation against a changed conversation policy/selection.
   * Output checkpoints remain writable after the attempt has been created. */
  initialThreadRevision?: number;
  /** Recheck authorization after the adapter has staged the body, before HTTP. */
  beforeDispatch?: () => Promise<void>;
  nextId(): string;
  now(): number;
  /** Reconnect only the storage client; never start a second provider request. */
  reconnectStorage?: () => Promise<StorageClient>;
  /** Await producer registration after creation is durable and before transport.
   * Rejection prevents dispatch and attempts a terminal failure checkpoint. */
  onCreated?: (value: {
    generationId: string;
    outputMessageId: string;
    createOperationId: string;
  }) => Promise<void>;
  /** Committed in the same transaction as the attempt's creation, so a record
   * that explains the attempt (such as a fallback event) cannot exist without
   * it or it without the record. */
  createWith?: (generationId: string) => CanonicalMutation[];
  /** Called only after canonical commit. Listener failures do not change history. */
  onCheckpoint?: (value: {
    generationId: string;
    sequence: number;
    partCount: number;
    terminal: boolean;
  }) => void;
}
export interface GenerationRunResult {
  generationId: string;
  terminal: Terminal | null;
  persisted: boolean;
  error: { code: string; message: string } | null;
}
export interface GenerationRun {
  result: Promise<GenerationRunResult>;
  cancel(): Promise<HostCancellationResult>;
}
const encode = new TextEncoder();
const digest = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
/** A live producer survives storage owner handoff. Only the producer coordinator
 * may declare a crashed producer lost; this consumer never runs crash recovery. */
export function startGeneration(options: GenerationRunOptions): GenerationRun {
  const initialThreadRevision = options.initialThreadRevision;
  if (initialThreadRevision !== undefined && (!Number.isSafeInteger(initialThreadRevision) || initialThreadRevision < 0))
    throw new RangeError("Initial thread revision must be a nonnegative safe integer");
  const adapter = options.adapter,
    input = structuredClone(options.input);
  const prepared = adapter.prepare(input);
  const { generation, output } = structuredClone(options.attempt);
  if (
    generation.status !== "streaming" ||
    generation.lastSequence !== 0 ||
    generation.outputMessageId !== output.id ||
    generation.provider !== adapter.binding.providerId ||
    generation.providerAccountId !== adapter.binding.accountId ||
    generation.model !== input.modelId ||
    output.sealed ||
    output.partCount !== 0 ||
    output.generationId !== generation.id ||
    output.threadId !== generation.threadId ||
    output.parentId !== generation.parentMessageId
  )
    throw new CompatibilityError([
      {
        code: "attempt_identity",
        message:
          "Generation requires a fresh, empty attempt bound to the selected provider account and model.",
        messageIndex: null,
        partId: null,
      },
    ]);
  // Record exactly the normalized parameters sent, without messages or credentials.
  generation.parameters = Object.fromEntries(
    Object.entries(prepared.body).filter(
      ([key]) => !["model", "messages", "system", "tools"].includes(key),
    ),
  );
  let summaryBytes = 0;
  let storage = options.storage,
    stream: ProviderStream | null = null,
    cancelled = false,
    sequence = 0,
    partCount = 0,
    rawCount = 0,
    rawBytes = 0,
    lastRaw: RawObject | null = null,
    terminal: Terminal | null = null;
  let responseId: string | null = null;
  let returnedModel: string | null = null;
  let responseHeaders: Record<string, string> = {};
  let reasoningBytes = 0;
  const reasoningIndexes = new Set<number>();
  const mutation = <K extends CanonicalMutation["kind"]>(
    kind: K,
    payload: Extract<CanonicalMutation, { kind: K }>["payload"],
  ): CanonicalMutation =>
    ({
      version: 1,
      operationId: options.nextId(),
      kind,
      recordedAt: options.now(),
      payload,
    }) as CanonicalMutation;
  const notify = (done = false) => {
    try {
      options.onCheckpoint?.({
        generationId: generation.id,
        sequence,
        partCount,
        terminal: done,
      });
    } catch {
      /* A view subscriber cannot turn a durable success into failure. */
    }
  };
  const status = async (mutations: CanonicalMutation[]) => {
    const values = [];
    for (const item of mutations)
      values.push(
        (
          await storage.request(options.nextId(), "operationStatus", {
            operationId: item.operationId,
          })
        ).status,
      );
    if (
      values.some((value) => value === "committed") &&
      !values.every((value) => value === "committed")
    )
      throw new Error(
        "Atomic provider checkpoint has inconsistent operation status.",
      );
    return values.every((value) => value === "committed");
  };
  const commit = async (
    mutations: CanonicalMutation[],
    blob?: { raw: RawObject; bytes: Uint8Array<ArrayBuffer> },
    expectedRevision?: number,
  ) => {
    const batch: MutationBatch = {
      transactionId: options.nextId(),
      mutations,
      expectedThreadRevisions: expectedRevision === undefined ? [] : [{ threadId: generation.threadId, revision: expectedRevision }],
      stagedBlobIds: [],
    };
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let transferId: string | null = null;
      try {
        if (attempt && (await status(mutations))) return;
        if (blob) {
          const stage = await storage.request(
            options.nextId(),
            "beginBlobTransfer",
            {
              operationId: options.nextId(),
              purpose: "raw_source",
              expectedBytes: blob.bytes.length,
              expectedSha256: blob.raw.sha256,
            },
          );
          transferId = stage.transferId;
          for (
            let offset = 0, sequence = 0;
            offset < blob.bytes.length || sequence === 0;
            sequence++
          ) {
            const bytes = blob.bytes.slice(
              offset,
              offset + Math.min(stage.maxChunkBytes, 65536),
            );
            await storage.sendChunk({
              transferId,
              sequence,
              offset,
              bytes,
              final: offset + bytes.length === blob.bytes.length,
            });
            offset += bytes.length;
            if (offset === blob.bytes.length) break;
          }
          await storage.request(options.nextId(), "finishBlobTransfer", {
            operationId: options.nextId(),
            transferId,
            expectedBytes: blob.bytes.length,
            expectedSha256: blob.raw.sha256!,
          });
          batch.stagedBlobIds = [transferId];
        }
        await storage.request(options.nextId(), "commit", batch);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string }).code;
        if (!["UNKNOWN_OUTCOME", "CLOSED"].includes(code ?? "")) throw error;
        if (options.reconnectStorage)
          storage = await options.reconnectStorage();
        // Unknown canonical replies are resolved by operation identity before
        // any byte transfer or mutation is retried.
        try {
          if (await status(mutations)) return;
        } catch (statusError) {
          if (
            !["UNKNOWN_OUTCOME", "CLOSED"].includes(
              (statusError as { code?: string }).code ?? "",
            )
          )
            throw statusError;
        }
      } finally {
        if (transferId)
          await storage
            .request(options.nextId(), "discardBlobTransfer", { transferId })
            .catch(() => {});
      }
    }
    throw lastError;
  };
  const part = (value: OutputPart): ContentPart =>
    ({
      ...value,
      id: options.nextId(),
      messageId: output.id,
      order: partCount,
    }) as ContentPart;
  let activeText: { key: string; partId: string; characters: number } | null =
    null;
  const append = async (value: OutputPart) => {
    if (partCount >= 100_000)
      throw new Error(
        "Generation exceeds its canonical checkpoint count bound.",
      );
    const item = part(value);
    await commit([
      mutation("AppendGenerationOutput", {
        generationId: generation.id,
        sequence: sequence + 1,
        newParts: [item],
        textAppend: null,
      }),
    ]);
    sequence++;
    partCount++;
    notify();
    return item;
  };
  // Raw transport checkpoints must not fragment a logical text block into
  // one SearchChunk source per network event. Bound each mutable text segment
  // while committing every delta and its sequence before advancing the cursor.
  const appendText = async (key: string, text: string) => {
    let offset = 0;
    while (offset < text.length) {
      if (activeText?.key !== key || activeText.characters >= 8192)
        activeText = null;
      const room = 8192 - (activeText?.characters ?? 0);
      let end = Math.min(text.length, offset + room);
      if (
        end < text.length &&
        end > offset &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      )
        end--;
      if (end === offset) {
        activeText = null;
        continue;
      }
      const piece = text.slice(offset, end);
      if (activeText) {
        await commit([
          mutation("AppendGenerationOutput", {
            generationId: generation.id,
            sequence: sequence + 1,
            newParts: [],
            textAppend: { partId: activeText.partId, text: piece },
          }),
        ]);
        sequence++;
        activeText.characters += piece.length;
        notify();
      } else {
        const item = await append({ kind: "Text", data: { text: piece } });
        activeText = { key, partId: item.id, characters: piece.length };
      }
      offset = end;
    }
  };
  const raw = async (
    bytes: Uint8Array<ArrayBuffer>,
    mediaType: string,
    providerKind: string,
    locator: string,
    final?: Terminal,
  ) => {
    if (partCount >= 100_000)
      throw new Error(
        "Generation exceeds its canonical checkpoint count bound.",
      );
    const rawObject: RawObject = {
      id: options.nextId(),
      availability: "available",
      sha256: await digest(bytes),
      byteLength: bytes.length,
      mediaType,
      storageRef: null,
    };
    rawObject.storageRef = `sha256:${rawObject.sha256}`;
    const item = part({
      kind: "ProviderArtifact",
      data: { providerKind, rawObjectId: rawObject.id, locator },
    });
    const mutations = [
      mutation("RegisterRawObject", { rawObject }),
      mutation("AppendGenerationOutput", {
        generationId: generation.id,
        sequence: sequence + 1,
        newParts: [item],
        textAppend: null,
      }),
    ];
    if (final) {
      const estimate = adapter.estimateCost(input.modelId, final.usage);
      mutations.push(
        mutation("CompleteGeneration", {
          generationId: generation.id,
          status: final.status,
          completedAt: options.now(),
          tokensIn: final.usage.inputTokens,
          tokensOut: final.usage.outputTokens,
          cachedTokens: final.usage.cachedInputTokens,
          estimatedCost: estimate.cost,
          reportedCost: null,
          rawResponseId: rawObject.id,
        }),
      );
      if (final.responseId)
        mutations.push(
          mutation("AttachProvenance", {
            provenance: [],
            identities: [
              {
                id: options.nextId(),
                provider: adapter.binding.providerId,
                accountScope: adapter.binding.accountId,
                sourceThreadId: null,
                sourceContainerKey: `live-generation:${generation.id}`,
                entityKind: "generation",
                nativeId: final.responseId,
                quixiId: generation.id,
              },
            ],
          }),
        );
    }
    await commit(mutations, { raw: rawObject, bytes });
    sequence++;
    partCount++;
    notify(Boolean(final));
    return rawObject;
  };
  const cancel = async (): Promise<HostCancellationResult> => {
    cancelled = true;
    return stream
      ? stream.cancel()
      : {
          requestId: input.requestId,
          outcome: "not_dispatched",
          externalEffect: "not_dispatched",
        };
  };
  const result = (async (): Promise<GenerationRunResult> => {
    try {
      const created = mutation("CreateGeneration", {
        generation,
        output,
        parts: [],
      });
      await commit([created, ...(options.createWith?.(generation.id) ?? [])], undefined, initialThreadRevision);
      notify();
      if (!cancelled && options.onCreated) {
        try {
          await options.onCreated({
            generationId: generation.id,
            outputMessageId: output.id,
            createOperationId: created.operationId,
          });
        } catch {
          terminal = {
            type: "terminal",
            status: "failed",
            stopReason: "producer_registration_failed",
            responseId: null,
            usage: emptyUsage(),
            error: {
              code: "transport",
              message:
                "Generation producer registration failed before provider dispatch.",
              status: null,
              providerCode: null,
              retryAfterMs: null,
              retry: "manual_new_attempt",
            },
          };
        }
      }
      if (cancelled)
        terminal = {
          type: "terminal",
          status: "cancelled",
          stopReason: "user_cancelled",
          responseId: null,
          usage: emptyUsage(),
          error: null,
        };
      if (!terminal) {
        stream = adapter.stream(input, options.beforeDispatch);
        if (cancelled) await stream.cancel();
        for await (const event of stream.events) {
          if (generation.purpose === "context_summary") {
            if (event.type === "text")
              summaryBytes += utf8ByteLength(event.text);
            else if (
              event.type === "part" &&
              (event.part.kind === "Text" || event.part.kind === "Note") &&
              event.part.data.text !== undefined
            )
              summaryBytes += utf8ByteLength(event.part.data.text);
            if (summaryBytes > SUMMARY_LIMITS.textBytes) {
              // A transport cancellation failure must not leave the bounded,
              // already committed prefix streaming and eligible for recovery.
              await stream.cancel().catch(() => {});
              terminal = {
                type: "terminal",
                status: "partial",
                stopReason: "summary_text_limit",
                responseId,
                usage: emptyUsage(),
                error: {
                  code: "limit",
                  message:
                    "Summary exceeded the 16 KiB review limit. Its retained partial output cannot be applied; choose a smaller prefix.",
                  status: null,
                  providerCode: null,
                  retryAfterMs: null,
                  retry: "manual_new_attempt",
                },
              };
              break;
            }
          }
          if (event.type === "raw") {
            if (event.sequence !== rawCount || event.bytes.length > 65536)
              throw new Error(
                "Provider raw checkpoint sequence or byte limit is invalid.",
              );
            lastRaw = await raw(
              event.bytes.slice(),
              "application/octet-stream",
              "quixi.provider.raw-stream-chunk",
              `bytes/${rawBytes}/${event.bytes.length}`,
            );
            rawCount++;
            rawBytes += event.bytes.length;
          } else if (event.type === "text")
            await appendText(event.key, event.text);
          else if (event.type === "part") {
            activeText = null;
            await append(event.part);
          } else if (event.type === "reasoning_block") {
            activeText = null;
            const block = event.block;
            const keys = block.type === "thinking" ? ["type", "thinking", "signature"] : ["type", "data"];
            const valid = block.type === "thinking"
              ? typeof block.thinking === "string" && typeof block.signature === "string" && !!block.signature
              : block.type === "redacted_thinking" && typeof block.data === "string" && !!block.data;
            let bytes: number;
            try { bytes = jsonByteLength(block, LIMITS.reasoningBlockBytes); }
            catch { throw new Error("Oversized complete thinking block receipt."); }
            if (adapter.protocol !== "anthropic" || !responseId || !lastRaw || !valid || Object.keys(block).some(key => !keys.includes(key)) ||
                !Number.isSafeInteger(event.index) || event.index < 0 || event.index >= LIMITS.parts || reasoningIndexes.has(event.index) ||
                !Number.isSafeInteger(event.startRecord) || !Number.isSafeInteger(event.endRecord) || event.startRecord < 1 || event.endRecord <= event.startRecord || event.endRecord > 100_000 ||
                bytes > LIMITS.reasoningBlockBytes || bytes > LIMITS.reasoningTotalBytes - reasoningBytes)
              throw new Error("Invalid or oversized complete thinking block receipt.");
            await raw(encode.encode(JSON.stringify({
              version: 1, protocol: "anthropic", generationId: generation.id,
              outputMessageId: output.id, responseId, model: input.modelId, returnedModel,
              index: event.index, source: { startRecord: event.startRecord, endRecord: event.endRecord,
                rawSegmentsThroughCheckpoint: rawCount, rawBytesThroughCheckpoint: rawBytes }, block,
            })), "application/json", "quixi.provider.anthropic-thinking-block", `block/${event.index}`);
            reasoningBytes += bytes; reasoningIndexes.add(event.index);
          } else if (event.type === "artifact") {
            activeText = null;
            if (!lastRaw)
              throw new Error(
                "Provider artifact has no preceding raw checkpoint.",
              );
            await append({
              kind: "ProviderArtifact",
              data: {
                providerKind: event.providerKind,
                rawObjectId: lastRaw.id,
                locator: `generation-stream/${event.locator}`,
              },
            });
          } else if (event.type === "metadata") {
            responseId = event.responseId ?? responseId;
            returnedModel = event.model ?? returnedModel;
            responseHeaders = { ...responseHeaders, ...event.headers };
          } else if (event.type === "terminal") terminal = event;
        }
      }
      if (!terminal)
        terminal = {
          type: "terminal",
          status: "partial",
          stopReason: "producer_stream_ended",
          responseId,
          usage: emptyUsage(),
          error: {
            code: "protocol",
            message: "Producer ended without a terminal event.",
            status: null,
            providerCode: null,
            retryAfterMs: null,
            retry: "manual_new_attempt",
          },
        };
      const estimate = adapter.estimateCost(input.modelId, terminal.usage);
      const manifest = {
        version: 1,
        protocol: adapter.protocol,
        generationId: generation.id,
        requestId: input.requestId,
        provider: adapter.binding.providerId,
        account: adapter.binding.accountId,
        model: input.modelId,
        returnedModel,
        responseId: terminal.responseId ?? responseId,
        responseHeaders,
        terminal,
        pricing: estimate.pricing,
        costReason: estimate.reason,
        capabilityProvenance: prepared.model.provenance,
        raw: {
          bytes: rawBytes,
          segments: rawCount,
          reassembly:
            "Read this output message’s ordered ProviderArtifact parts whose providerKind is quixi.provider.raw-stream-chunk; concatenate the referenced verified bytes in part order. generation-stream/record locators refer to SSE records in that concatenated stream.",
        },
      };
      await raw(
        encode.encode(JSON.stringify(manifest)),
        "application/vnd.quixi.provider-response+json",
        "quixi.provider.response-manifest",
        "/",
        terminal,
      );
      return {
        generationId: generation.id,
        terminal,
        persisted: true,
        error: null,
      };
    } catch (error) {
      await stream?.cancel().catch(() => {});
      const code = (error as { code?: string }).code ?? "INTERNAL";
      return {
        generationId: generation.id,
        terminal,
        persisted: false,
        error: {
          code,
          message:
            error instanceof Error
              ? error.message.slice(0, 512)
              : "Provider checkpoint could not be committed; retained canonical checkpoints remain available. Recover only after this producer is confirmed stopped.",
        },
      };
    }
  })();
  return { result, cancel };
}
