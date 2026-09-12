import {
  count,
  emptyUsage,
  LIMITS,
  object,
  protocolFailure,
  string,
  type ProviderEvent,
  type ProviderUsage,
  type Protocol,
} from "./types.ts";
import type { JsonObject, JsonValue } from "@quixi/core/model";
import { parseEvent, type SSERecord } from "./sse.ts";
import { jsonByteLength } from "@quixi/core/contracts";
type Event = Exclude<ProviderEvent, { type: "raw" } | { type: "terminal" }>;
type ReasoningBlock = Extract<ProviderEvent, { type: "reasoning_block" }>["block"];
export class Normalizer {
  responseId: string | null = null;
  model: string | null = null;
  usage = emptyUsage();
  stopReason: string | null = null;
  ended = false;
  hasOutput = false;
  private started = false;
  private toolBytes = 0;
  private records = 0;
  private reasoningBytes = 0;
  private reasoning = new Map<number, { block: ReasoningBlock; bytes: number; startRecord: number; signing: boolean }>();
  private tools = new Map<
    number,
    {
      id: string;
      name: string;
      arguments: string;
      bytes: number;
      initial: JsonValue;
    }
  >();
  private blocks = new Map<
    number,
    { type: string; key: string; closed: boolean }
  >();
  constructor(readonly protocol: Protocol) {}
  private captureBytes(value: JsonValue): number {
    try { return jsonByteLength(value, LIMITS.reasoningBlockBytes); }
    catch { throw protocolFailure("Thinking capture exceeds its byte limit.", "limit"); }
  }
  accept(record: SSERecord): Event[] {
    if (this.ended)
      throw protocolFailure("Provider emitted data after its terminal marker.");
    if (++this.records > 100_000)
      throw protocolFailure(
        "Provider stream exceeds the event count limit.",
        "limit",
      );
    if (this.protocol === "openai-compatible" && record.data === "[DONE]") {
      if (!this.stopReason)
        throw protocolFailure("Provider terminal marker has no finish reason.");
      this.ended = true;
      return [];
    }
    const data = object(parseEvent(record.data));
    if (data.error || record.event === "error" || data.type === "error")
      throw protocolFailure(
        "Provider reported an error inside the response stream.",
        "provider_error",
      );
    return this.protocol === "openai-compatible"
      ? this.openai(data)
      : this.anthropic(data, record);
  }
  private metadata(data: JsonObject): Event[] {
    const id = string(data.id),
      model = string(data.model);
    if (this.responseId && id && id !== this.responseId)
      throw protocolFailure(
        "Provider response identity changed inside one stream.",
      );
    if (!id) throw protocolFailure("Provider response has no valid identity.");
    this.responseId = id;
    if (model) this.model = model;
    return [
      {
        type: "metadata",
        responseId: this.responseId,
        model: this.model,
        headers: {},
      },
    ];
  }
  private updateUsage(data: JsonObject): Event {
    const combined = { ...this.usage.raw, ...data };
    if (new TextEncoder().encode(JSON.stringify(combined)).length > 65536)
      throw protocolFailure(
        "Provider usage metadata exceeds the 64 KiB accumulation bound.",
        "limit",
      );
    this.usage.raw = combined;
    const raw = this.usage.raw;
    if (this.protocol === "openai-compatible") {
      this.usage.inputTokens = count(raw.prompt_tokens);
      this.usage.outputTokens = count(raw.completion_tokens);
      const prompt =
        raw.prompt_tokens_details &&
        typeof raw.prompt_tokens_details === "object" &&
        !Array.isArray(raw.prompt_tokens_details)
          ? raw.prompt_tokens_details
          : {};
      const completion =
        raw.completion_tokens_details &&
        typeof raw.completion_tokens_details === "object" &&
        !Array.isArray(raw.completion_tokens_details)
          ? raw.completion_tokens_details
          : {};
      this.usage.cachedInputTokens = count(prompt.cached_tokens);
      this.usage.cacheWriteInputTokens = count(prompt.cache_write_tokens);
      this.usage.reasoningTokens = count(completion.reasoning_tokens);
    } else {
      const uncached = count(raw.input_tokens),
        cached = count(raw.cache_read_input_tokens),
        written = count(raw.cache_creation_input_tokens);
      this.usage.inputTokens =
        uncached === null ? null : uncached + (cached ?? 0) + (written ?? 0);
      this.usage.outputTokens = count(raw.output_tokens);
      this.usage.cachedInputTokens = cached;
      this.usage.cacheWriteInputTokens = written;
      const details =
        raw.output_tokens_details &&
        typeof raw.output_tokens_details === "object" &&
        !Array.isArray(raw.output_tokens_details)
          ? raw.output_tokens_details
          : {};
      this.usage.reasoningTokens = count(details.thinking_tokens);
    }
    if (
      this.usage.inputTokens !== null &&
      !Number.isSafeInteger(this.usage.inputTokens)
    )
      throw protocolFailure("Provider token usage exceeds integer bounds.");
    return { type: "usage", usage: structuredClone(this.usage) };
  }
  private text(key: string, text: JsonValue | undefined): Event[] {
    if (text === undefined || text === null || text === "") return [];
    if (typeof text !== "string")
      throw protocolFailure("Provider text delta is not a string.");
    this.hasOutput = true;
    const events: Event[] = [];
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + 16_384, text.length);
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      events.push({ type: "text", key, text: text.slice(offset, end) });
      offset = end;
    }
    return events;
  }
  private appendTool(index: number, fragment: string) {
    const tool = this.tools.get(index);
    if (!tool)
      throw protocolFailure("Provider tool delta has no matching start.");
    const bytes = new TextEncoder().encode(fragment).length;
    this.toolBytes += bytes;
    if (
      this.toolBytes > LIMITS.toolTotalBytes ||
      tool.bytes + bytes > LIMITS.toolBytes
    )
      throw protocolFailure(
        "Provider tool arguments exceed the buffer limit.",
        "limit",
      );
    tool.bytes += bytes;
    tool.arguments += fragment;
  }
  private finishTool(index: number): Event {
    const tool = this.tools.get(index);
    if (!tool || !tool.id || !tool.name)
      throw protocolFailure("Provider tool call has incomplete identity.");
    const value = tool.arguments ? parseEvent(tool.arguments) : tool.initial;
    this.tools.delete(index);
    this.toolBytes -= new TextEncoder().encode(tool.arguments).length;
    this.hasOutput = true;
    return {
      type: "part",
      key: `tool:${tool.id}`,
      part: {
        kind: "ToolCall",
        data: {
          name: tool.name,
          input: value as JsonValue,
          providerCallId: tool.id,
        },
      },
    };
  }
  private openai(data: JsonObject): Event[] {
    const events: Event[] = [];
    if (!this.started) {
      events.push(...this.metadata(data));
      this.started = true;
    } else {
      const id = string(data.id);
      if (id && id !== this.responseId)
        throw protocolFailure("Provider response identity changed.");
    }
    if (data.usage !== undefined && data.usage !== null)
      events.push(this.updateUsage(object(data.usage)));
    if (!Array.isArray(data.choices))
      throw protocolFailure(
        "OpenAI-compatible stream is missing its choices array.",
      );
    for (const item of data.choices) {
      const choice = object(item);
      if (choice.index !== 0)
        throw protocolFailure(
          "Multiple response choices require separate generation attempts.",
        );
      const delta = object(choice.delta ?? {});
      if (this.stopReason && Object.keys(delta).length)
        throw protocolFailure("OpenAI emitted content after finish_reason.");
      events.push(...this.text("text:0", delta.content));
      if (delta.refusal) {
        events.push(...this.text("refusal:0", delta.refusal));
        events.push({
          type: "part",
          key: "refusal-metadata",
          part: {
            kind: "StructuredData",
            data: { value: { type: "provider_refusal" } },
          },
        });
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls))
          throw protocolFailure("Malformed tool delta list.");
        for (const item of delta.tool_calls) {
          const tool = object(item);
          const index = count(tool.index);
          if (index === null || index >= 64)
            throw protocolFailure("Tool index exceeds the supported bound.");
          const fn = object(tool.function ?? {});
          if (!this.tools.has(index)) {
            if (this.tools.size >= 64)
              throw protocolFailure("Too many active tool calls.", "limit");
            this.tools.set(index, {
              id: string(tool.id, 512) ?? "",
              name: string(fn.name, 128) ?? "",
              arguments: "",
              bytes: 0,
              initial: {},
            });
          }
          const current = this.tools.get(index)!;
          if (tool.id && string(tool.id, 512) !== current.id)
            throw protocolFailure("Provider tool identity changed.");
          if (fn.name && string(fn.name, 128) !== current.name)
            throw protocolFailure("Provider tool name changed.");
          if (fn.arguments !== undefined) {
            if (typeof fn.arguments !== "string")
              throw protocolFailure("Tool argument delta is not text.");
            this.appendTool(index, fn.arguments);
          }
        }
      }
      if (delta.annotations !== undefined) {
        if (!Array.isArray(delta.annotations))
          throw protocolFailure("Invalid citation annotations.");
        for (const [index, item] of delta.annotations.entries()) {
          const annotation = object(item);
          if (annotation.type === "url_citation") {
            const citation = object(annotation.url_citation);
            events.push({
              type: "part",
              key: `citation:${this.records}:${index}`,
              part: {
                kind: "Citation",
                data: {
                  url: string(citation.url, 8192),
                  label: string(citation.title),
                  sourcePartId: null,
                },
              },
            });
          } else
            events.push({
              type: "artifact",
              key: `annotation:${this.records}:${index}`,
              providerKind: String(annotation.type ?? "unknown"),
              locator: `record/${this.records}/annotation/${index}`,
            });
        }
      }
      for (const key of Object.keys(delta))
        if (
          !["role", "content", "refusal", "tool_calls", "annotations"].includes(
            key,
          )
        ) {
          events.push({
            type: "artifact",
            key: `delta:${this.records}:${key}`,
            providerKind: `openai.delta.${key}`,
            locator: `record/${this.records}/delta/${key}`,
          });
        }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        this.stopReason = string(choice.finish_reason, 128);
        if (!this.stopReason)
          throw protocolFailure("Malformed provider finish reason.");
        for (const index of [...this.tools.keys()])
          events.push(this.finishTool(index));
      }
    }
    return events;
  }
  private anthropic(data: JsonObject, record: SSERecord): Event[] {
    const type = string(data.type, 128);
    if (!type || (record.event !== "message" && record.event !== type))
      throw protocolFailure(
        "Anthropic event name disagrees with its JSON type.",
      );
    const events: Event[] = [];
    if (type === "ping") return events;
    if (type === "message_start") {
      if (this.started)
        throw protocolFailure("Duplicate Anthropic message_start.");
      this.started = true;
      const message = object(data.message);
      events.push(...this.metadata(message));
      if (message.usage) events.push(this.updateUsage(object(message.usage)));
      return events;
    }
    if (!this.started)
      throw protocolFailure("Anthropic stream has no message_start.");
    if (type === "content_block_start") {
      const index = count(data.index);
      if (index === null || index >= LIMITS.parts || this.blocks.has(index))
        throw protocolFailure("Invalid or duplicate Anthropic block index.");
      const block = object(data.content_block);
      const kind = string(block.type, 128);
      if (!kind) throw protocolFailure("Anthropic block has no type.");
      const key = `block:${index}`;
      this.blocks.set(index, { type: kind, key, closed: false });
      if (kind === "text") events.push(...this.text(key, block.text));
      else if (kind === "tool_use") {
        if (this.tools.size >= 64)
          throw protocolFailure("Too many active tools.", "limit");
        this.tools.set(index, {
          id: string(block.id, 512) ?? "",
          name: string(block.name, 128) ?? "",
          arguments: "",
          bytes: 0,
          initial: block.input ?? {},
        });
      } else if (kind === "thinking" || kind === "redacted_thinking") {
        const allowed = kind === "thinking" ? ["type", "thinking", "signature"] : ["type", "data"];
        if (Object.keys(block).some(key => !allowed.includes(key)) || this.reasoning.size >= 64)
          throw protocolFailure("Unsupported thinking block fields or too many open blocks.");
        if (kind === "thinking" ? typeof block.thinking !== "string" || (block.signature !== undefined && typeof block.signature !== "string") : typeof block.data !== "string" || !block.data)
          throw protocolFailure("Malformed thinking block.");
        const captured: ReasoningBlock = kind === "thinking"
          ? { type: "thinking", thinking: block.thinking as string, signature: block.signature as string ?? "" }
          : { type: "redacted_thinking", data: block.data as string };
        const bytes = this.captureBytes(captured);
        if (bytes > LIMITS.reasoningBlockBytes || bytes > LIMITS.reasoningTotalBytes - this.reasoningBytes)
          throw protocolFailure("Thinking capture exceeds its byte limit.", "limit");
        this.reasoningBytes += bytes;
        this.reasoning.set(index, { block: captured, bytes, startRecord: this.records, signing: kind === "thinking" && !!block.signature });
        events.push({
          type: "part",
          key,
          part: {
            kind: "ReasoningMetadata",
            data: { redacted: kind === "redacted_thinking", summary: null },
          },
        });
        events.push({
          type: "artifact",
          key: `raw:${key}`,
          providerKind: kind,
          locator: `record/${this.records}`,
        });
      } else
        events.push({
          type: "artifact",
          key,
          providerKind: kind,
          locator: `record/${this.records}`,
        });
      return events;
    }
    if (type === "content_block_delta") {
      const index = count(data.index),
        block = index === null ? undefined : this.blocks.get(index);
      if (!block || block.closed)
        throw protocolFailure("Anthropic delta has no open content block.");
      const delta = object(data.delta);
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        const captured = this.reasoning.get(index!);
        const field = delta.type === "thinking_delta" ? "thinking" : delta.type === "signature_delta" ? "signature" : null;
        if (!captured || captured.block.type !== "thinking" || !field || typeof delta[field] !== "string" || Object.keys(delta).some(key => key !== "type" && key !== field) || (field === "thinking" && captured.signing))
          throw protocolFailure("Unsupported or out-of-order thinking delta.");
        // Count escaped JSON bytes before concatenating. Split surrogate pairs
        // conservatively consume extra credit but their exact text is retained.
        const bytes = this.captureBytes(delta[field]) - 2;
        if (bytes > LIMITS.reasoningBlockBytes - captured.bytes || bytes > LIMITS.reasoningTotalBytes - this.reasoningBytes)
          throw protocolFailure("Thinking capture exceeds its byte limit.", "limit");
        captured.bytes += bytes; this.reasoningBytes += bytes;
        captured.block[field] += delta[field];
        if (field === "signature") captured.signing = true;
      }
      if (delta.type === "text_delta" && block.type === "text")
        events.push(...this.text(block.key, delta.text));
      else if (delta.type === "input_json_delta" && block.type === "tool_use") {
        if (typeof delta.partial_json !== "string")
          throw protocolFailure("Tool JSON delta is malformed.");
        this.appendTool(index!, delta.partial_json);
      } else if (delta.type === "citations_delta") {
        const citation = object(delta.citation);
        events.push({
          type: "part",
          key: `citation:${this.records}`,
          part: {
            kind: "Citation",
            data: {
              url: string(citation.url, 8192),
              label: string(citation.title) ?? string(citation.document_title),
              sourcePartId: null,
            },
          },
        });
      } else
        events.push({
          type: "artifact",
          key: `delta:${this.records}`,
          providerKind: String(delta.type ?? "unknown"),
          locator: `record/${this.records}`,
        });
      return events;
    }
    if (type === "content_block_stop") {
      const index = count(data.index),
        block = index === null ? undefined : this.blocks.get(index);
      if (!block || block.closed)
        throw protocolFailure(
          "Anthropic block stop has no matching open block.",
        );
      block.closed = true;
      if (block.type === "tool_use") events.push(this.finishTool(index!));
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        const captured = this.reasoning.get(index!);
        if (!captured || (captured.block.type === "thinking" && !captured.block.signature))
          throw protocolFailure("Thinking block closed without its complete signature.");
        this.reasoning.delete(index!);
        events.push({ type: "reasoning_block", index: index!, startRecord: captured.startRecord, endRecord: this.records, block: captured.block });
      }
      return events;
    }
    if (type === "message_delta") {
      const delta = object(data.delta);
      if (delta.stop_reason !== undefined && delta.stop_reason !== null)
        this.stopReason = string(delta.stop_reason, 128);
      if (data.usage) events.push(this.updateUsage(object(data.usage)));
      return events;
    }
    if (type === "message_stop") {
      if (
        !this.stopReason ||
        [...this.blocks.values()].some((block) => !block.closed)
      )
        throw protocolFailure(
          "Anthropic message ended with missing stop metadata or open blocks.",
        );
      this.ended = true;
      return events;
    }
    events.push({
      type: "artifact",
      key: `event:${this.records}`,
      providerKind: type,
      locator: `record/${this.records}`,
    });
    return events;
  }
  terminalStatus(): "complete" | "stopped" | "partial" {
    if (!this.ended) return "partial";
    if (
      ["stop", "end_turn", "stop_sequence", "tool_calls", "tool_use"].includes(
        this.stopReason ?? "",
      )
    )
      return "complete";
    return "stopped";
  }
}
