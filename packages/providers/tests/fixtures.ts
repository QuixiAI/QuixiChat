import type {
  ModelDescription,
  Protocol,
  ProviderInput,
} from "../src/index.ts";
export const sse = (data: unknown, event?: string) =>
  `${event ? `event: ${event}\r\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\r\n\r\n`;
export const chat = (delta: unknown, finish_reason: string | null = null) => ({
  id: "chatcmpl-synthetic",
  model: "synthetic-model",
  choices: [{ index: 0, delta, finish_reason }],
});
export function fixture(protocol: Protocol, mode = "complete"): string {
  if (protocol === "openai-compatible") {
    const start = sse(chat({ role: "assistant", content: "Hello 🧪 " }));
    if (mode === "malformed") return start + sse("{broken");
    if (mode === "truncated") return start;
    if (mode === "slow") return start;
    const finish = mode === "limited" ? "length" : "tool_calls";
    return (
      start +
      sse(
        chat({
          tool_calls: [
            {
              index: 0,
              id: "call-synthetic",
              type: "function",
              function: { name: "lookup", arguments: '{"q":' },
            },
          ],
        }),
      ) +
      sse(
        chat({
          tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }],
          reasoning_content: "synthetic private reasoning",
          annotations: [
            {
              type: "url_citation",
              url_citation: {
                url: "https://example.invalid/source",
                title: "Synthetic citation",
              },
            },
          ],
        }),
      ) +
      sse(chat({ content: "done" }, finish)) +
      sse({
        id: "chatcmpl-synthetic",
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      }) +
      sse("[DONE]")
    );
  }
  const event = (type: string, rest: Record<string, unknown> = {}) =>
    sse({ type, ...rest }, type);
  const start =
    event("message_start", {
      message: {
        id: "msg-synthetic",
        model: "synthetic-model",
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      },
    }) +
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "Hello 🧪 " },
    });
  if (mode === "malformed")
    return start + sse("{broken", "content_block_delta");
  if (mode === "truncated" || mode === "slow") return start;
  // The documented thinking order: signed and redacted blocks close before the
  // text block opens, with nothing the reviewed request profile refuses.
  if (mode === "reasoned")
    return (
      event("message_start", {
        message: { id: "msg-reasoned", model: "reasoned", usage: { input_tokens: 12, output_tokens: 1 } },
      }) +
      event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }) +
      event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "\ufeffreasoned 🧪 " } }) +
      event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "in two parts\r\n" } }) +
      event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "reasoned-signature+/=" } }) +
      event("content_block_stop", { index: 0 }) +
      event("content_block_start", { index: 1, content_block: { type: "redacted_thinking", data: "reasoned-redacted+/=" } }) +
      event("content_block_stop", { index: 1 }) +
      event("content_block_start", { index: 2, content_block: { type: "text", text: "" } }) +
      event("content_block_delta", { index: 2, delta: { type: "text_delta", text: "Reasoned answer 🧪" } }) +
      event("content_block_stop", { index: 2 }) +
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }) +
      event("message_stop")
    );
  return (
    start +
    event("content_block_delta", {
      index: 0,
      delta: {
        type: "citations_delta",
        citation: {
          type: "web_search_result_location",
          url: "https://example.invalid/source",
          title: "Synthetic citation",
        },
      },
    }) +
    event("content_block_stop", { index: 0 }) +
    event("content_block_start", {
      index: 1,
      content_block: { type: "thinking", thinking: "" },
    }) +
    event("content_block_delta", {
      index: 1,
      delta: { type: "thinking_delta", thinking: "synthetic reasoning" },
    }) +
    event("content_block_delta", {
      index: 1,
      delta: { type: "signature_delta", signature: "synthetic-signature" },
    }) +
    event("content_block_stop", { index: 1 }) +
    event("content_block_start", {
      index: 2,
      content_block: {
        type: "tool_use",
        id: "toolu-synthetic",
        name: "lookup",
        input: {},
      },
    }) +
    event("content_block_delta", {
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"q":' },
    }) +
    event("content_block_delta", {
      index: 2,
      delta: { type: "input_json_delta", partial_json: '"fixture"}' },
    }) +
    event("content_block_stop", { index: 2 }) +
    event("content_block_start", {
      index: 3,
      content_block: { type: "redacted_thinking", data: "synthetic-encrypted+/=" },
    }) +
    event("content_block_stop", { index: 3 }) +
    event("content_block_start", {
      index: 4,
      content_block: { type: "future_file_output", file_id: "file-synthetic" },
    }) +
    event("content_block_stop", { index: 4 }) +
    event("message_delta", {
      delta: { stop_reason: mode === "limited" ? "max_tokens" : "tool_use" },
      usage: { output_tokens: 7 },
    }) +
    event("message_stop")
  );
}
export const model = (
  protocol: Protocol,
  id = "synthetic-model",
  options: { images?: boolean; thinking?: boolean } = {},
): ModelDescription => ({
  id,
  name: "Controlled fixture model",
  protocol,
  capabilities: {
    inputModalities: options.images ? ["text", "image"] : ["text"],
    outputModalities: ["text"],
    contextWindow: 8192,
    maxOutputTokens: options.thinking ? 4096 : 1024,
    ...(options.thinking ? { thinkingProfile: "anthropic-manual-haiku-4.5" as const } : {}),
    streaming: "supported",
    tools: "supported",
    reasoning: "unknown",
    structuredOutput: "unsupported",
    images: options.images ? "supported" : "unsupported",
    files: "unsupported",
    webSearch: "unknown",
    imageGeneration: "unsupported",
    systemPromptMode: protocol === "anthropic" ? "top_level" : "system",
    parameters: options.thinking
      ? ["maxOutputTokens", "temperature", "topP", "stopSequences", "thinkingBudgetTokens"]
      : ["maxOutputTokens", "temperature", "topP", "stopSequences"],
  },
  pricing: {
    currency: "USD",
    inputPerMillion: "2",
    outputPerMillion: "8",
    cachedInputPerMillion: "0.5",
    cacheWriteInputPerMillion: null,
    sourceUrl: "https://example.invalid/synthetic-pricing",
    verifiedAt: 1,
  },
  provenance: {
    source: "operator_catalog",
    sourceUrl: "https://example.invalid/synthetic-catalog",
    observedAt: 1,
  },
  raw: null,
});
export const input = (modelId = "synthetic-model"): ProviderInput => ({
  requestId: crypto.randomUUID(),
  modelId,
  systemPrompt: "Synthetic system",
  messages: [
    {
      role: "user",
      parts: [
        {
          id: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          order: 0,
          kind: "Text",
          data: { text: "Synthetic prompt" },
        },
      ],
    },
  ],
  parameters: { maxOutputTokens: 100 },
  tools: [
    {
      name: "lookup",
      description: "Synthetic local fixture only",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
});
