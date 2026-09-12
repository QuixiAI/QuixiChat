import type {
  HostCancellationResult,
  HostHttpResponse,
} from "@quixi/core/contracts";
import type { JsonObject } from "@quixi/core/model";
import { Normalizer } from "./normalize.ts";
import { analyzeCompatibility, prepare } from "./request.ts";
import { SSEDecoder, parseEvent } from "./sse.ts";
import {
  emptyUsage,
  LIMITS,
  object,
  protocolFailure,
  StreamFailure,
  string,
  unknownCapabilities,
  type AccountHealth,
  type ModelDescription,
  type PreparedRequest,
  type Protocol,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderFailure,
  type ProviderOptions,
  type ProviderUsage,
} from "./types.ts";
const encoder = new TextEncoder();
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
export function createAdapter(
  protocol: Protocol,
  options: ProviderOptions,
): ProviderAdapter {
  options = {
    ...options,
    binding: structuredClone(options.binding),
    credential: structuredClone(options.credential),
  };
  const catalog = new Map(
    options.catalog
      .filter((model) => model.protocol === protocol)
      .map((model) => [model.id, structuredClone(model)]),
  );
  let health: AccountHealth = {
    status: "unknown",
    observedAt: options.now(),
    retryAt: null,
    reason: null,
    evidence: "none",
  };
  let healthRevision = 0;
  const updateHealth = (
    failure: ProviderFailure | null,
    evidence: AccountHealth["evidence"],
  ) => {
    healthRevision++;
    const status =
      failure === null
        ? "healthy"
        : failure.code === "authentication"
          ? "authentication_expired"
          : failure.code === "rate_limit"
            ? "rate_limited"
            : failure.code === "region_unavailable"
              ? "region_unavailable"
              : failure.code === "provider_error"
                ? "provider_degraded"
                : "unknown";
    health = {
      status,
      observedAt: options.now(),
      retryAt:
        failure && failure.retryAfterMs !== null
          ? options.now() + failure.retryAfterMs
          : null,
      reason: failure?.message ?? null,
      evidence,
    };
  };
  const adapter: ProviderAdapter = {
    protocol,
    binding: structuredClone(options.binding),
    describeAccount: () => ({
      binding: structuredClone(options.binding),
      label: options.accountLabel?.slice(0, 256) ?? null,
      credentialPersistence: options.credential?.persistence ?? null,
      health: structuredClone(health),
    }),
    describeModel: (id) =>
      catalog.has(id) ? structuredClone(catalog.get(id)!) : null,
    capabilities: (id) =>
      catalog.has(id) ? structuredClone(catalog.get(id)!.capabilities) : null,
    accountHealth: () => structuredClone(health),
    async listModels(cursor: string | null = null, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const requestId = options.nextId();
      const observedRevision = healthRevision;
      if (
        cursor !== null &&
        (typeof cursor !== "string" || !cursor || cursor.length > 256)
      )
        throw new StreamFailure({
          code: "invalid_request",
          message: "Model listing cursor is invalid.",
          status: null,
          providerCode: null,
          retryAfterMs: null,
          retry: "manual_new_attempt",
        });
      let response: HostHttpResponse | null = null;
      const cancel = () => {
        void options.host.cancel(requestId).catch(() => {});
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        signal?.throwIfAborted();
        response = await options.host.startProviderHttp({
          requestId,
          binding: options.binding,
          method: "GET",
          path: "/v1/models",
          ...(protocol === "anthropic"
            ? {
                query: {
                  limit: String(LIMITS.modelPageSize),
                  ...(cursor ? { after_id: cursor } : {}),
                },
              }
            : {}),
          headers:
            protocol === "anthropic"
              ? { "anthropic-version": "2023-06-01" }
              : {},
          credential: options.credential,
          bodyTransferId: null,
          timeout: { connectMs: 15000, idleMs: 15000, totalMs: 30000 },
        }, async () => { signal?.throwIfAborted(); });
        signal?.throwIfAborted();
        const bytes = await collect(
          options,
          response,
          LIMITS.modelResponseBytes,
          signal,
        );
        signal?.throwIfAborted();
        if (response.status < 200 || response.status >= 300)
          throw new StreamFailure(httpFailure(response, bytes, options.now()));
        const data = object(
          parseEvent(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
        if (!Array.isArray(data.data) || data.data.length > LIMITS.models)
          throw protocolFailure(
            "Provider model listing exceeds its bound or has invalid data.",
          );
        const models = data.data.map((value) => {
          const raw = object(value);
          const id = string(raw.id, 256);
          if (!id)
            throw protocolFailure(
              "Provider returned an invalid model identifier.",
            );
          return catalog.has(id)
            ? { ...structuredClone(catalog.get(id)!), raw }
            : {
                id,
                name: string(raw.display_name, 256) ?? id,
                protocol,
                capabilities: structuredClone(unknownCapabilities),
                pricing: null,
                provenance: {
                  source: "provider_list" as const,
                  sourceUrl: null,
                  observedAt: options.now(),
                },
                raw,
              };
        });
        // A slow metadata request must not replace a newer foreground outcome
        // (or a model probe that has already produced a newer observation).
        if (healthRevision === observedRevision) updateHealth(null, "models_probe");
        const more = data.has_more === true;
        // Only Anthropic documents a cursor; an OpenAI-compatible listing that
        // claims more pages is reported incomplete without a way to continue.
        const nextCursor =
          more && protocol === "anthropic" ? string(data.last_id, 256) : null;
        return { models, complete: !more, nextCursor };
      } catch (error) {
        signal?.throwIfAborted();
        const failure = asFailure(error);
        if (healthRevision === observedRevision) updateHealth(failure, "models_probe");
        throw new StreamFailure(failure);
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (response?.bodyTransferId)
          await options.host
            .releaseTransfer(options.nextId(), response.bodyTransferId)
            .catch(() => {});
      }
    },
    async authenticate(signal?: AbortSignal) {
      try {
        await adapter.listModels(null, signal);
      } catch {
        signal?.throwIfAborted();
        /* Health contains typed probe outcome. */
      }
      return adapter.accountHealth();
    },
    prepare: (input) =>
      prepare(protocol, input, adapter.describeModel(input.modelId)),
    analyze: (input) =>
      analyzeCompatibility(protocol, input, adapter.describeModel(input.modelId)),
    async countTokens(input, beforeDispatch) {
      const prepared = adapter.prepare(input);
      if (protocol !== "anthropic")
        return {
          tokens: null,
          source: "unavailable",
          reason:
            "Token counting is not implemented for this Chat Completions connection.",
        };
      // Anthropic's count endpoint takes the same model, system, messages and
      // tools as a generation; generation-only fields are dropped.
      const {
        max_tokens: _maxTokens,
        stream: _stream,
        temperature: _temperature,
        top_p: _topP,
        stop_sequences: _stopSequences,
        ...counted
      } = prepared.body;
      const bytes = encoder.encode(JSON.stringify(counted)),
        digest = await sha256(bytes);
      let stage: string | null = null,
        response: HostHttpResponse | null = null;
      try {
        const declaration = await options.host.beginTransfer(options.nextId(), {
          purpose: "provider_request",
          expectedBytes: bytes.length,
          expectedSha256: digest,
        });
        stage = declaration.transferId;
        for (let offset = 0, sequence = 0; offset < bytes.length; sequence++) {
          const part = bytes.slice(
            offset,
            offset + Math.min(65536, declaration.maxChunkBytes),
          );
          await options.host.writeChunk({
            transferId: stage,
            sequence,
            offset,
            bytes: part,
            final: offset + part.length === bytes.length,
          });
          offset += part.length;
        }
        await options.host.finishTransfer(options.nextId(), stage, {
          byteLength: bytes.length,
          sha256: digest,
        });
        await beforeDispatch?.();
        response = await options.host.startProviderHttp({
          requestId: options.nextId(),
          binding: options.binding,
          method: "POST",
          path: "/v1/messages/count_tokens",
          headers: prepared.headers,
          credential: options.credential,
          bodyTransferId: stage,
          timeout: { connectMs: 15000, idleMs: 15000, totalMs: 30000 },
        }, beforeDispatch);
        const body = await collect(options, response, LIMITS.modelResponseBytes);
        if (response.status < 200 || response.status >= 300)
          throw new StreamFailure(httpFailure(response, body, options.now()));
        const data = object(
          parseEvent(new TextDecoder("utf-8", { fatal: true }).decode(body)),
        );
        const tokens = data.input_tokens;
        if (
          typeof tokens !== "number" ||
          !Number.isSafeInteger(tokens) ||
          tokens < 0
        )
          throw protocolFailure("Provider token count is not a whole number.");
        updateHealth(null, "transport");
        return { tokens, source: "provider", reason: null };
      } catch (error) {
        const failure = asFailure(error);
        updateHealth(failure, "transport");
        return { tokens: null, source: "unavailable", reason: failure.message };
      } finally {
        if (stage)
          await options.host
            .releaseTransfer(options.nextId(), stage)
            .catch(() => {});
        if (response?.bodyTransferId)
          await options.host
            .releaseTransfer(options.nextId(), response.bodyTransferId)
            .catch(() => {});
      }
    },
    estimateCost(modelId, usage) {
      const pricing = catalog.get(modelId)?.pricing ?? null;
      if (
        !pricing ||
        usage.inputTokens === null ||
        usage.outputTokens === null ||
        [
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedInputTokens,
          usage.cacheWriteInputTokens,
        ].some(
          (value) =>
            value !== null && (!Number.isSafeInteger(value) || value < 0),
        )
      )
        return {
          cost: null,
          pricing,
          reason:
            "Reviewed pricing and complete input/output usage are required.",
        };
      if (
        (pricing.cachedInputPerMillion !== null &&
          usage.cachedInputTokens === null) ||
        (pricing.cacheWriteInputPerMillion !== null &&
          usage.cacheWriteInputTokens === null)
      )
        return {
          cost: null,
          pricing,
          reason: "Cache usage is unknown for differentiated cache pricing.",
        };
      const cached = usage.cachedInputTokens ?? 0,
        written = usage.cacheWriteInputTokens ?? 0,
        uncached = usage.inputTokens - cached - written;
      if (
        uncached < 0 ||
        (cached > 0 && pricing.cachedInputPerMillion === null) ||
        (written > 0 && pricing.cacheWriteInputPerMillion === null)
      )
        return {
          cost: null,
          pricing,
          reason: "Cache accounting or its reviewed price is incomplete.",
        };
      const decimal = (value: string) => {
        if (!/^\d{1,12}(\.\d{1,9})?$/.test(value))
          throw new Error("Invalid reviewed price");
        const [whole, fraction = ""] = value.split(".");
        return (
          BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"))
        );
      };
      try {
        const numerator =
          BigInt(uncached) * decimal(pricing.inputPerMillion) +
          BigInt(usage.outputTokens) * decimal(pricing.outputPerMillion) +
          BigInt(cached) * decimal(pricing.cachedInputPerMillion ?? "0") +
          BigInt(written) * decimal(pricing.cacheWriteInputPerMillion ?? "0");
        const units = (numerator + 999_999n) / 1_000_000n;
        const amount = `${units / 1_000_000_000n}.${(units % 1_000_000_000n).toString().padStart(9, "0")}`;
        return {
          cost: { amount, currency: pricing.currency },
          pricing,
          reason: null,
        };
      } catch {
        return {
          cost: null,
          pricing,
          reason: "Reviewed pricing has invalid decimal values.",
        };
      }
    },
    stream(input, beforeDispatch) {
      // Validate and encode bounded attachments before copying the request;
      // unused or oversized caller-supplied attachment buffers are never cloned.
      const prepared = structuredClone(adapter.prepare(input));
      const identity = { requestId: input.requestId, modelId: input.modelId };
      let cancelled = false,
        dispatched = false,
        complete = false,
        claimed = false;
      const cancel = async (): Promise<HostCancellationResult> => {
        cancelled = true;
        if (!dispatched)
          return {
            requestId: identity.requestId,
            outcome: complete ? "already_completed" : "not_dispatched",
            externalEffect: "not_dispatched",
          };
        if (complete)
          return {
            requestId: identity.requestId,
            outcome: "already_completed",
            externalEffect: "may_have_occurred",
          };
        return options.host.cancel(identity.requestId);
      };
      const events = {
        async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
          if (claimed)
            throw new Error("A provider stream has only one consumer.");
          claimed = true;
          const normalizer = new Normalizer(protocol);
          let response: HostHttpResponse | null = null,
            stage: string | null = null,
            output = false;
          let bytesSeen = 0,
            rawSequence = 0;
          let terminal: Extract<ProviderEvent, { type: "terminal" }> | null =
            null;
          try {
            if (cancelled) throw protocolFailure("Cancelled before dispatch.");
            const bytes = encoder.encode(JSON.stringify(prepared.body)),
              digest = await sha256(bytes);
            const declaration = await options.host.beginTransfer(
              options.nextId(),
              {
                purpose: "provider_request",
                expectedBytes: bytes.length,
                expectedSha256: digest,
              },
            );
            stage = declaration.transferId;
            for (
              let offset = 0, sequence = 0;
              offset < bytes.length;
              sequence++
            ) {
              if (cancelled) break;
              const part = bytes.slice(
                offset,
                offset + Math.min(65536, declaration.maxChunkBytes),
              );
              await options.host.writeChunk({
                transferId: stage,
                sequence,
                offset,
                bytes: part,
                final: offset + part.length === bytes.length,
              });
              offset += part.length;
            }
            if (cancelled) throw protocolFailure("Cancelled before dispatch.");
            await options.host.finishTransfer(options.nextId(), stage, {
              byteLength: bytes.length,
              sha256: digest,
            });
            if (cancelled) throw protocolFailure("Cancelled before dispatch.");
            await beforeDispatch?.();
            if (cancelled) throw protocolFailure("Cancelled before dispatch.");
            dispatched = true;
            response = await options.host.startProviderHttp({
              requestId: identity.requestId,
              binding: options.binding,
              method: "POST",
              path: prepared.path,
              headers: prepared.headers,
              credential: options.credential,
              bodyTransferId: stage,
              timeout: { connectMs: 30000, idleMs: 30000, totalMs: 600000 },
            }, beforeDispatch);
            await options.host.releaseTransfer(options.nextId(), stage);
            stage = null;
            yield {
              type: "metadata",
              responseId: null,
              model: identity.modelId,
              headers: response.headers,
            };
            if (response.status < 200 || response.status >= 300) {
              const bytes = await collect(options, response, 65536);
              yield { type: "raw", sequence: rawSequence++, bytes };
              throw new StreamFailure(
                httpFailure(response, bytes, options.now()),
              );
            }
            if (
              !response.bodyTransferId ||
              !(response.headers["content-type"] ?? "")
                .toLowerCase()
                .startsWith("text/event-stream")
            )
              throw protocolFailure(
                "Provider did not return an SSE response stream.",
              );
            const parser = new SSEDecoder();
            for (;;) {
              if (cancelled) break;
              const chunk = await options.host.readChunk(
                response.bodyTransferId,
              );
              bytesSeen += chunk.bytes.length;
              if (bytesSeen > LIMITS.streamBytes)
                throw protocolFailure(
                  "Provider stream exceeds the 64 MiB attempt limit.",
                  "limit",
                );
              // Checkpoint consumer owns the bytes before parsing and before the
              // read acknowledgement permits another transport chunk.
              yield {
                type: "raw",
                sequence: rawSequence++,
                bytes: chunk.bytes,
              };
              for (const record of parser.push(chunk.bytes, chunk.final))
                for (const event of normalizer.accept(record)) {
                  if (
                    event.type === "text" ||
                    event.type === "part" ||
                    event.type === "artifact"
                  )
                    output = true;
                  yield event;
                }
              await options.host.acknowledgeChunk({
                transferId: chunk.transferId,
                sequence: chunk.sequence,
                committedOffset: chunk.offset + chunk.bytes.length,
              });
              if (chunk.final || normalizer.ended) break;
            }
            if (cancelled && !normalizer.ended) {
              terminal = {
                type: "terminal",
                status: "cancelled",
                stopReason: "user_cancelled",
                responseId: normalizer.responseId,
                usage: normalizer.usage,
                error: null,
              };
            } else if (!normalizer.ended) {
              throw protocolFailure(
                "Provider stream closed before its terminal marker.",
              );
            } else {
              updateHealth(null, "generation");
              terminal = {
                type: "terminal",
                status: normalizer.terminalStatus(),
                stopReason: normalizer.stopReason,
                responseId: normalizer.responseId,
                usage: normalizer.usage,
                error: null,
              };
            }
          } catch (error) {
            const failure = asFailure(error);
            if (!cancelled) updateHealth(failure, "generation");
            terminal = {
              type: "terminal",
              status: cancelled ? "cancelled" : output ? "partial" : "failed",
              stopReason: cancelled ? "user_cancelled" : null,
              responseId: normalizer.responseId,
              usage: normalizer.usage,
              error: cancelled ? null : failure,
            };
          } finally {
            complete = true;
            if (response?.bodyTransferId)
              await options.host
                .releaseTransfer(options.nextId(), response.bodyTransferId)
                .catch(() => {});
            else if (dispatched)
              await options.host.cancel(identity.requestId).catch(() => {});
            if (stage)
              await options.host
                .releaseTransfer(options.nextId(), stage)
                .catch(() => {});
          }
          if (terminal) yield terminal;
        },
      };
      return { events, cancel };
    },
  };
  return adapter;
}
async function collect(
  options: ProviderOptions,
  response: HostHttpResponse,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.bodyTransferId) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    signal?.throwIfAborted();
    const chunk = await options.host.readChunk(response.bodyTransferId);
    signal?.throwIfAborted();
    size += chunk.bytes.length;
    if (size > limit)
      throw protocolFailure(
        "Provider metadata response exceeds its byte limit.",
        "limit",
      );
    chunks.push(chunk.bytes);
    await options.host.acknowledgeChunk({
      transferId: chunk.transferId,
      sequence: chunk.sequence,
      committedOffset: chunk.offset + chunk.bytes.length,
    });
    signal?.throwIfAborted();
    if (chunk.final) break;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function asFailure(error: unknown): ProviderFailure {
  if (error instanceof StreamFailure) return error.failure;
  const value = error as { code?: unknown };
  return {
    code:
      value?.code === "INVALID_REQUEST"
        ? "invalid_request"
        : value?.code === "UNSUPPORTED"
          ? "unsupported"
          : "transport",
    message:
      value?.code === "UNSUPPORTED"
        ? "Host transport capability is unavailable."
        : "Provider transport failed or was interrupted.",
    status: null,
    providerCode: null,
    retryAfterMs: null,
    retry: "manual_new_attempt",
  };
}
function httpFailure(
  response: HostHttpResponse,
  bytes: Uint8Array,
  now: number,
): ProviderFailure {
  let providerCode: string | null = null,
    message = "Provider rejected the request.";
  try {
    const value = object(parseEvent(new TextDecoder().decode(bytes)));
    const error =
      value.error && typeof value.error === "object"
        ? object(value.error)
        : value;
    providerCode = string(error.code, 128) ?? string(error.type, 128);
    message = string(error.message, 512) ?? message;
  } catch {
    /* Preserve raw bytes independently without unsafe error parsing. */
  }
  const retry = response.headers["retry-after"];
  let retryAfterMs: number | null = null;
  if (retry) {
    const seconds = Number(retry);
    retryAfterMs =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.min(seconds * 1000, 86_400_000)
        : Number.isFinite(Date.parse(retry))
          ? Math.max(0, Math.min(Date.parse(retry) - now, 86_400_000))
          : null;
  }
  const code =
    response.status === 401
      ? "authentication"
      : response.status === 429
        ? "rate_limit"
        : providerCode === "unsupported_country_region_territory"
          ? "region_unavailable"
          : response.status === 403
            ? "permission"
            : response.status >= 500
              ? "provider_error"
              : "invalid_request";
  return {
    code,
    message,
    status: response.status,
    providerCode,
    retryAfterMs,
    retry:
      code === "authentication" ||
      code === "permission" ||
      code === "region_unavailable"
        ? "after_user_action"
        : "manual_new_attempt",
  };
}
