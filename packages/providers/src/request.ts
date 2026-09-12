import {
  CompatibilityError,
  IMAGE_MEDIA_TYPES,
  FILE_MEDIA_TYPES,
  AUDIO_MEDIA_TYPES,
  normalizeAudioMediaType,
  LIMITS,
  type CompatibilityIssue,
  type CompatibilityReport,
  type PreparedRequest,
  type ProviderInput,
  type ModelDescription,
  type Protocol,
} from "./types.ts";
import {
  isJsonValue,
  isQuixiId,
  isReasoningEvidencePart,
  type ContentPart,
  type JsonObject,
  type JsonValue,
} from "@quixi/core/model";
import { thinkingBlockBytes, validateThinkingBlock } from "./reasoning.ts";
interface MappedRequest {
  issues: CompatibilityIssue[];
  preserved: { id: string; kind: ContentPart["kind"] }[];
  requestBytes: number;
  prepared: PreparedRequest;
}
/** Map and refuse: the request a generation sends, or every issue at once. */
export function prepare(
  protocol: Protocol,
  input: ProviderInput,
  model: ModelDescription | null,
): PreparedRequest {
  const mapped = map(protocol, input, model);
  if (mapped.issues.length)
    throw new CompatibilityError(mapped.issues.slice(0, 64));
  return mapped.prepared;
}
/** The same mapping as a report: what would be carried, refused or constrained. */
export function analyzeCompatibility(
  protocol: Protocol,
  input: ProviderInput,
  model: ModelDescription | null,
): CompatibilityReport {
  const kindOf = (partId: string | null): ContentPart["kind"] | null => {
    if (!partId) return null;
    for (const message of input.messages)
      for (const part of message.parts) if (part.id === partId) return part.kind;
    return null;
  };
  const report = (
    issues: CompatibilityIssue[],
    preserved: MappedRequest["preserved"],
    requestBytes: number | null,
  ): CompatibilityReport => {
    const byKind: Partial<Record<ContentPart["kind"], number>> = {};
    for (const part of preserved) byKind[part.kind] = (byKind[part.kind] ?? 0) + 1;
    const contextWindow = model?.capabilities.contextWindow ?? null;
    const maxOutputTokens = input.parameters.maxOutputTokens;
    return {
      target: { protocol, modelId: input.modelId },
      context: {
        contextWindow,
        maxOutputTokens,
        inputRoom: contextWindow === null ? null : Math.max(0, contextWindow - maxOutputTokens),
      },
      pricing: model?.pricing ?? null,
      preserved: { parts: preserved.length, byKind },
      blocked: issues
        .filter((issue) => issue.partId !== null)
        .map((issue) => ({ partId: issue.partId, kind: kindOf(issue.partId), code: issue.code, message: issue.message })),
      constraints: issues.filter((issue) => issue.partId === null),
      requestBytes,
      sendable: issues.length === 0,
    };
  };
  try {
    const mapped = map(protocol, input, model);
    return report(mapped.issues, mapped.preserved, mapped.requestBytes);
  } catch (error) {
    if (error instanceof CompatibilityError) return report(error.issues, [], null);
    throw error;
  }
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}
function map(
  protocol: Protocol,
  input: ProviderInput,
  model: ModelDescription | null,
): MappedRequest {
  const issues: CompatibilityIssue[] = [];
  const preserved: MappedRequest["preserved"] = [];
  const issue = (
    code: string,
    message: string,
    messageIndex: number | null = null,
    partId: string | null = null,
  ) => {
    if (issues.length < 64)
      issues.push({ code, message, messageIndex, partId });
  };
  if (!model || model.protocol !== protocol)
    throw new CompatibilityError([
      {
        code: "model_catalog_required",
        message:
          "Register reviewed capabilities for this model before generation.",
        messageIndex: null,
        partId: null,
      },
    ]);
  if (
    !isQuixiId(input.requestId) ||
    input.messages.length === 0 ||
    input.messages.length > 2048
  )
    throw new CompatibilityError([
      {
        code: "invalid_request",
        message: "A bounded conversation and valid request ID are required.",
        messageIndex: null,
        partId: null,
      },
    ]);
  validateBoundedInput(input);
  if (
    model.capabilities.streaming !== "supported" ||
    !model.capabilities.inputModalities.includes("text")
  )
    issue(
      "unsupported_model",
      "This catalog entry does not confirm streaming text input support.",
    );
  if (
    !Number.isSafeInteger(input.parameters.maxOutputTokens) ||
    input.parameters.maxOutputTokens < 1 ||
    (model.capabilities.maxOutputTokens !== null &&
      input.parameters.maxOutputTokens > model.capabilities.maxOutputTokens)
  )
    issue(
      "token_limit",
      "Requested output-token limit exceeds known model capability.",
    );
  for (const [key, value] of Object.entries(input.parameters))
    if (
      value !== undefined &&
      !model.capabilities.parameters.includes(key as never)
    )
      issue(
        "parameter_unsupported",
        `The model catalog does not permit ${key}.`,
      );
  if (
    input.parameters.temperature !== undefined &&
    (!Number.isFinite(input.parameters.temperature) ||
      input.parameters.temperature < 0 ||
      input.parameters.temperature > (protocol === "anthropic" ? 1 : 2))
  )
    issue("temperature", "Temperature is outside the protocol range.");
  if (
    input.parameters.topP !== undefined &&
    (!Number.isFinite(input.parameters.topP) ||
      input.parameters.topP < 0 ||
      input.parameters.topP > 1)
  )
    issue("top_p", "Top-p is outside the protocol range.");
  if (
    input.parameters.stopSequences &&
    (input.parameters.stopSequences.length > 4 ||
      input.parameters.stopSequences.some(
        (value) =>
          typeof value !== "string" || value.length === 0 || value.length > 1024,
      ))
  )
    issue("stop_sequences", "Stop sequences exceed the supported bound.");
  // Manual thinking follows Anthropic's extended-thinking contract for the
  // reviewed Haiku 4.5 profile (read 2026-09-11): a budget of at least 1,024
  // tokens below max_tokens, no temperature, top-p only within 0.95–1.
  const budget = input.parameters.thinkingBudgetTokens;
  if (budget !== undefined) {
    if (protocol !== "anthropic" || model.capabilities.thinkingProfile !== "anthropic-manual-haiku-4.5")
      issue("thinking_unsupported", "This catalog entry has no reviewed thinking profile; Quixi enables thinking only for Claude Haiku 4.5 manual mode.");
    else {
      if (!Number.isSafeInteger(budget) || budget < LIMITS.thinkingBudgetMin)
        issue("thinking_budget", "Thinking budgets are whole numbers of at least 1,024 tokens.");
      else if (budget >= input.parameters.maxOutputTokens)
        issue("thinking_budget", "The thinking budget must be less than the output-token limit, which thinking tokens count toward.");
      if (input.parameters.temperature !== undefined)
        issue("thinking_temperature", "Temperature cannot be set while thinking is enabled for this model.");
      if (input.parameters.topP !== undefined && !(input.parameters.topP >= 0.95 && input.parameters.topP <= 1))
        issue("thinking_top_p", "Top-p must be between 0.95 and 1 while thinking is enabled for this model.");
    }
  }
  let reasoningBytes = 0;
  if (
    input.tools?.length &&
    (model.capabilities.tools !== "supported" || input.tools.length > 64)
  )
    issue(
      "tools_unsupported",
      "Tools are not supported by this model catalog entry or exceed its bound.",
    );
  let textChars = input.systemPrompt?.length ?? 0;
  let partCount = 0;
  let imageCount = 0;
  let fileCount = 0;
  let audioCount = 0;
  let attachmentBytes = 0;
  const messages: JsonObject[] = [];
  for (const [messageIndex, message] of input.messages.entries()) {
    if (!message.parts.length)
      issue(
        "empty_content",
        "Provider messages require explicit content.",
        messageIndex,
      );
    if (
      message.role === "tool" &&
      message.parts.some((part) => part.kind !== "ToolResult")
    )
      issue(
        "tool_result_role",
        "Tool messages require resolved provider tool results.",
        messageIndex,
      );
    if (!["user", "assistant", "tool", "system"].includes(message.role))
      issue("role", "Unsupported canonical role.", messageIndex);
    if (
      protocol === "openai-compatible" &&
      message.role === "system" &&
      model.capabilities.systemPromptMode !== "system"
    )
      issue(
        "system_mode",
        "This model requires the explicitly configured system prompt field.",
        messageIndex,
      );
    if (protocol === "anthropic" && message.role === "system") {
      issue(
        "system_position",
        "Anthropic requires system content in the explicit top-level system prompt.",
        messageIndex,
      );
      continue;
    }
    const texts: string[] = [];
    const blocks: JsonObject[] = [];
    const calls: JsonObject[] = [];
    // OpenAI content stays a string unless an image, file or audio part requires blocks.
    const openaiContent: JsonObject[] = [];
    let toolId: string | null = null;
    // Thinking blocks are carried only from verified complete blocks, in their
    // original order and before any other block of the assistant message.
    let reasoningCount = 0, lastReasoningIndex = -1;
    for (const part of message.parts) {
      if (++partCount > LIMITS.parts)
        throw new CompatibilityError([
          {
            code: "part_limit",
            message: "Conversation has too many content parts.",
            messageIndex,
            partId: part.id,
          },
        ]);
      if (part.kind === "Text" && part.data.text !== undefined) {
        textChars += part.data.text.length;
        texts.push(part.data.text);
        blocks.push({ type: "text", text: part.data.text });
        openaiContent.push({ type: "text", text: part.data.text });
        preserved.push({ id: part.id, kind: part.kind });
      } else if (part.kind === "Image") {
        // Images travel as base64 blocks from verified attachment bytes the
        // caller supplied; every unsupported case is an explicit issue.
        const attachment = input.attachments?.[part.data.attachmentId];
        if (
          model.capabilities.images !== "supported" ||
          !model.capabilities.inputModalities.includes("image")
        )
          issue(
            "images_unsupported",
            "This model catalog entry does not confirm image input.",
            messageIndex,
            part.id,
          );
        else if (message.role !== "user")
          issue(
            "image_role",
            "Images can only be sent in user messages.",
            messageIndex,
            part.id,
          );
        else if (!attachment)
          issue(
            "image_unavailable",
            "The image bytes are not available for this request.",
            messageIndex,
            part.id,
          );
        else if (!IMAGE_MEDIA_TYPES.includes(attachment.mediaType))
          issue(
            "image_media_unsupported",
            `Images of type ${attachment.mediaType} are not supported by this request profile.`,
            messageIndex,
            part.id,
          );
        else if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.length === 0)
          issue("image_unavailable", "The image bytes are empty or unavailable.", messageIndex, part.id);
        else if (attachment.bytes.length > LIMITS.imageBytes)
          issue(
            "image_too_large",
            `Images are limited to ${LIMITS.imageBytes.toLocaleString()} bytes for this request profile.`,
            messageIndex,
            part.id,
          );
        else if (++imageCount > LIMITS.imagesPerRequest)
          issue(
            "image_limit",
            `Requests carry at most ${LIMITS.imagesPerRequest} images.`,
            messageIndex,
            part.id,
          );
        else if (attachment.bytes.length > LIMITS.attachmentBytes - attachmentBytes)
          issue("attachment_total_limit", "Images, files and audio together exceed the 2.5 MiB raw request bound.", messageIndex, part.id);
        else {
          attachmentBytes += attachment.bytes.length;
          const data = base64(attachment.bytes);
          textChars += data.length;
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: attachment.mediaType, data },
          });
          openaiContent.push({
            type: "image_url",
            image_url: { url: `data:${attachment.mediaType};base64,${data}` },
          });
          preserved.push({ id: part.id, kind: part.kind });
        }
      } else if (part.kind === "File") {
        const attachment = input.attachments?.[part.data.attachmentId];
        const filename = attachment?.filename ?? "attachment.pdf";
        if (model.capabilities.files !== "supported" || !model.capabilities.inputModalities.includes("file") || !model.capabilities.fileMediaTypes?.length)
          issue("files_unsupported", "This model catalog entry does not confirm reviewed file input.", messageIndex, part.id);
        else if (message.role !== "user")
          issue("file_role", "Files can only be sent in user messages.", messageIndex, part.id);
        else if (!attachment)
          issue("file_unavailable", "The file bytes are empty or unavailable for this request.", messageIndex, part.id);
        else if (!FILE_MEDIA_TYPES.includes(attachment.mediaType) || !model.capabilities.fileMediaTypes.includes(attachment.mediaType))
          issue("file_media_unsupported", "This request profile accepts only reviewed PDF file inputs.", messageIndex, part.id);
        else if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.length === 0)
          issue("file_unavailable", "The file bytes are empty or unavailable for this request.", messageIndex, part.id);
        else if (typeof filename !== "string" || filename.length === 0 || filename.length > 255 || /[\/\\\u0000-\u001f]/.test(filename))
          issue("file_name", "Files require a bounded plain filename without path separators or controls.", messageIndex, part.id);
        else if (attachment.bytes.length > LIMITS.fileBytes)
          issue("file_too_large", "PDF files are limited to 2.5 MiB for this request profile.", messageIndex, part.id);
        else if (++fileCount > LIMITS.filesPerRequest)
          issue("file_limit", "Requests carry at most 20 PDF files.", messageIndex, part.id);
        else if (attachment.bytes.length > LIMITS.attachmentBytes - attachmentBytes)
          issue("attachment_total_limit", "Images, files and audio together exceed the 2.5 MiB raw request bound.", messageIndex, part.id);
        else {
          attachmentBytes += attachment.bytes.length;
          const data = base64(attachment.bytes);
          textChars += data.length;
          blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: filename });
          openaiContent.push({ type: "file", file: { filename, file_data: `data:application/pdf;base64,${data}` } });
          preserved.push({ id: part.id, kind: part.kind });
        }
      } else if (part.kind === "Audio") {
        const attachment = input.attachments?.[part.data.attachmentId];
        const mediaType = attachment ? normalizeAudioMediaType(attachment.mediaType) : null;
        if (protocol !== "openai-compatible")
          issue("audio_protocol_unsupported", "This provider protocol does not implement audio input.", messageIndex, part.id);
        else if (!model.capabilities.inputModalities.includes("audio") || !model.capabilities.audioMediaTypes?.length)
          issue("audio_unsupported", "This model catalog entry does not confirm reviewed audio input.", messageIndex, part.id);
        else if (message.role !== "user")
          issue("audio_role", "Audio can only be sent in user messages.", messageIndex, part.id);
        else if (!attachment)
          issue("audio_unavailable", "The audio bytes are empty or unavailable for this request.", messageIndex, part.id);
        else if (!mediaType || !AUDIO_MEDIA_TYPES.includes(mediaType) || !model.capabilities.audioMediaTypes.includes(mediaType))
          issue("audio_media_unsupported", "This request profile accepts only reviewed WAV or MP3 audio inputs.", messageIndex, part.id);
        else if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.length === 0)
          issue("audio_unavailable", "The audio bytes are empty or unavailable for this request.", messageIndex, part.id);
        else if (attachment.bytes.length > LIMITS.audioBytes)
          issue("audio_too_large", "Audio is limited to 2.5 MiB for this request profile.", messageIndex, part.id);
        else if (++audioCount > LIMITS.audioPerRequest)
          issue("audio_limit", "Requests carry at most 20 audio inputs.", messageIndex, part.id);
        else if (attachment.bytes.length > LIMITS.attachmentBytes - attachmentBytes)
          issue("attachment_total_limit", "Images, files and audio together exceed the 2.5 MiB raw request bound.", messageIndex, part.id);
        else {
          attachmentBytes += attachment.bytes.length;
          const data = base64(attachment.bytes);
          textChars += data.length;
          openaiContent.push({ type: "input_audio", input_audio: { data, format: mediaType === "audio/wav" ? "wav" : "mp3" } });
          preserved.push({ id: part.id, kind: part.kind });
        }
      } else if (
        part.kind === "ToolCall" &&
        model.capabilities.tools === "supported" &&
        message.role === "assistant" &&
        part.data.providerCallId
      ) {
        if (!isJsonValue(part.data.input))
          issue("tool_json", "Tool input must be JSON.", messageIndex, part.id);
        calls.push({
          id: part.data.providerCallId,
          type: "function",
          function: {
            name: part.data.name,
            arguments: JSON.stringify(part.data.input),
          },
        });
        blocks.push({
          type: "tool_use",
          id: part.data.providerCallId,
          name: part.data.name,
          input: part.data.input,
        });
        preserved.push({ id: part.id, kind: part.kind });
      } else if (
        part.kind === "ToolResult" &&
        model.capabilities.tools === "supported" &&
        part.data.unresolvedProviderCallId
      ) {
        if (!isJsonValue(part.data.content))
          issue(
            "tool_json",
            "Tool result must be JSON.",
            messageIndex,
            part.id,
          );
        if (
          protocol === "openai-compatible" &&
          (message.role !== "tool" || message.parts.length !== 1)
        )
          issue(
            "tool_result_role",
            "OpenAI tool results require a dedicated tool message.",
            messageIndex,
            part.id,
          );
        if (
          protocol === "anthropic" &&
          !["user", "tool"].includes(message.role)
        )
          issue(
            "tool_result_role",
            "Anthropic tool results require a user or tool message.",
            messageIndex,
            part.id,
          );
        toolId = part.data.unresolvedProviderCallId;
        texts.push(
          typeof part.data.content === "string"
            ? part.data.content
            : JSON.stringify(part.data.content),
        );
        blocks.push({
          type: "tool_result",
          tool_use_id: toolId,
          content:
            typeof part.data.content === "string"
              ? part.data.content
              : JSON.stringify(part.data.content),
          is_error: part.data.isError,
        });
        preserved.push({ id: part.id, kind: part.kind });
      } else if (part.kind === "ReasoningMetadata") {
        const entry = input.reasoning?.[part.id];
        const block = entry ? validateThinkingBlock(entry.block) : null;
        const bytes = block ? thinkingBlockBytes(block) : null;
        if (protocol !== "anthropic")
          issue("reasoning_unsupported", "This provider protocol has no input representation for Anthropic thinking blocks.", messageIndex, part.id);
        else if (message.role !== "assistant")
          issue("reasoning_role", "Thinking blocks belong to assistant messages only.", messageIndex, part.id);
        else if (!entry)
          issue("reasoning_evidence_missing", "No verified complete thinking block is retained for this reasoning marker; a display summary is not evidence.", messageIndex, part.id);
        else if (entry.protocol !== "anthropic" || entry.messageId !== part.messageId)
          issue("reasoning_evidence_mismatch", "The verified thinking block does not belong to this message.", messageIndex, part.id);
        else if (model.capabilities.thinkingProfile !== "anthropic-manual-haiku-4.5" || entry.modelId !== input.modelId)
          issue("reasoning_model_mismatch", `Thinking blocks are readable only by the model that produced them (${entry.modelId}); this request targets ${input.modelId}.`, messageIndex, part.id);
        else if (!block || (block.type === "redacted_thinking") !== part.data.redacted)
          issue("reasoning_evidence_invalid", "The thinking block evidence is malformed or disagrees with its marker.", messageIndex, part.id);
        else if (blocks.length !== reasoningCount || !Number.isSafeInteger(entry.index) || entry.index <= lastReasoningIndex)
          issue("reasoning_order", "Thinking blocks must precede other content in their assistant message, in their original order.", messageIndex, part.id);
        else if (bytes === null || bytes > LIMITS.reasoningTotalBytes - reasoningBytes)
          issue("reasoning_limit", "Thinking blocks exceed the 256 KiB per-block or 1 MiB per-request bound.", messageIndex, part.id);
        else {
          reasoningBytes += bytes;
          textChars += bytes;
          reasoningCount++;
          lastReasoningIndex = entry.index;
          blocks.push(block.type === "thinking"
            ? { type: "thinking", thinking: block.thinking, signature: block.signature }
            : { type: "redacted_thinking", data: block.data });
          preserved.push({ id: part.id, kind: part.kind });
        }
      } else if (isReasoningEvidencePart(part))
        issue("reasoning_evidence_part", "Thinking receipts and stream locators are evidence for a reasoning marker, not request content.", messageIndex, part.id);
      else if (part.kind === "Citation")
        issue("citation_unsupported", "Citations have no input representation without their cited documents; the workflow sends a plain source note instead.", messageIndex, part.id);
      else if (part.kind === "StructuredData")
        issue("structured_data_unsupported", "Structured output values have no input representation; the workflow sends their JSON text instead.", messageIndex, part.id);
      else if (part.kind === "ProviderArtifact")
        issue("provider_artifact_unsupported", `Provider-specific ${part.data.providerKind} content has no input representation on this protocol.`, messageIndex, part.id);
      else
        issue(
          "content_mapping",
          `Explicit compatibility handling is required for ${part.kind}${part.kind === "Text" ? " backed by a blob" : ""}.`,
          messageIndex,
          part.id,
        );
    }
    if (protocol === "anthropic")
      messages.push({
        role: message.role === "tool" ? "user" : message.role,
        content: blocks,
      });
    else
      messages.push({
        role: message.role,
        content: openaiContent.some((block) => block.type === "image_url" || block.type === "file" || block.type === "input_audio")
          ? openaiContent
          : texts.length
            ? texts.join("")
            : null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(toolId ? { tool_call_id: toolId } : {}),
      });
  }
  if (textChars > LIMITS.requestBytes)
    issue(
      "request_limit",
      "Conversation exceeds the initial request size bound.",
    );
  if (
    input.systemPrompt &&
    ["unsupported", "unknown"].includes(model.capabilities.systemPromptMode)
  )
    issue(
      "system_unsupported",
      "System prompt support is unavailable or unknown.",
    );
  if (
    protocol === "openai-compatible" &&
    input.systemPrompt &&
    !["system", "developer"].includes(model.capabilities.systemPromptMode)
  )
    issue(
      "system_mode",
      "OpenAI-compatible catalog entries require system or developer prompt mode.",
    );
  if (
    protocol === "anthropic" &&
    input.systemPrompt &&
    model.capabilities.systemPromptMode !== "top_level"
  )
    issue(
      "system_mode",
      "Anthropic catalog entries require top-level system prompts.",
    );
  const body: JsonObject = { model: input.modelId, messages, stream: true };
  if (protocol === "anthropic") {
    body.max_tokens = input.parameters.maxOutputTokens;
    if (input.systemPrompt) body.system = input.systemPrompt;
    if (budget !== undefined) body.thinking = { type: "enabled", budget_tokens: budget };
  } else {
    body.max_completion_tokens = input.parameters.maxOutputTokens;
    body.store = false;
    if (model.capabilities.inputModalities.includes("audio") || model.capabilities.outputModalities.includes("audio")) body.modalities = ["text"];
    body.stream_options = { include_usage: true };
    if (input.systemPrompt)
      messages.unshift({
        role: model.capabilities.systemPromptMode,
        content: input.systemPrompt,
      });
  }
  if (input.parameters.temperature !== undefined)
    body.temperature = input.parameters.temperature;
  if (input.parameters.topP !== undefined) body.top_p = input.parameters.topP;
  if (input.parameters.stopSequences?.length)
    body[protocol === "anthropic" ? "stop_sequences" : "stop"] = [
      ...input.parameters.stopSequences,
    ];
  if (input.tools?.length)
    body.tools = input.tools.map((tool) => {
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
        tool.description.length > 4096 ||
        !isJsonValue(tool.inputSchema)
      )
        issue("tool_schema", "Tool schema or identity is invalid.");
      return protocol === "anthropic"
        ? {
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          }
        : {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          };
    }) as JsonValue;
  const requestBytes = new TextEncoder().encode(JSON.stringify(body)).length;
  if (requestBytes > LIMITS.requestBytes)
    issue("request_limit", "Encoded provider request exceeds 4 MiB.");
  return {
    issues,
    preserved,
    requestBytes,
    prepared: {
      requestId: input.requestId,
      model,
      path: protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        ...(protocol === "anthropic"
          ? { "anthropic-version": "2023-06-01" }
          : {}),
      },
      body,
    },
  };
}

/** Reject oversized/deep/cyclic caller values before stringification allocates a request. */
function validateBoundedInput(input: ProviderInput): void {
  // Attachment bytes are bounded per media part and by their base64 expansion in
  // prepare(); walking them as JSON would count every byte as a node.
  const { attachments, ...structure } = input;
  for (const [key, value] of Object.entries(attachments ?? {}))
    if (!isQuixiId(key) || !(value?.bytes instanceof Uint8Array) || typeof value.mediaType !== "string" || value.mediaType.length > 128)
      throw new CompatibilityError([
        { code: "invalid_request", message: "Provider attachments require verified bytes keyed by attachment ID.", messageIndex: null, partId: null },
      ]);
  const pending: [unknown, number][] = [[structure, 0]];
  let nodes = 0,
    chars = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++nodes > 40000 || depth > 32)
      throw new CompatibilityError([
        {
          code: "request_limit",
          message: "Provider input structure exceeds its bound.",
          messageIndex: null,
          partId: null,
        },
      ]);
    if (typeof item === "string") {
      chars += item.length;
      if (chars > LIMITS.requestBytes)
        throw new CompatibilityError([
          {
            code: "request_limit",
            message: "Provider input exceeds 4 MiB.",
            messageIndex: null,
            partId: null,
          },
        ]);
    } else if (
      (typeof item === "number" && !Number.isFinite(item)) ||
      typeof item === "bigint" ||
      typeof item === "function"
    )
      throw new CompatibilityError([
        {
          code: "invalid_json",
          message: "Provider input contains a value outside JSON.",
          messageIndex: null,
          partId: null,
        },
      ]);
    else if (item && typeof item === "object") {
      for (const key in item)
        if (Object.hasOwn(item, key)) {
          chars += key.length;
          if (nodes + pending.length >= 40000 || chars > LIMITS.requestBytes)
            throw new CompatibilityError([
              {
                code: "request_limit",
                message: "Provider input collection exceeds its bound.",
                messageIndex: null,
                partId: null,
              },
            ]);
          pending.push([(item as Record<string, unknown>)[key], depth + 1]);
        }
    }
  }
}
