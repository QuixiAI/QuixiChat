import type { IncomingMessage, ServerResponse } from "node:http";
import { fixture } from "./fixtures.ts";
import { audioFixture } from "./audio-fixtures.ts";
export const fixtureStats: {
  requests: number; disconnected: number; audioWav: number; audioMp3: number;
  /** Continuation requests: the thinking parameter and every assistant
   * thinking/redacted block exactly as received, for the proof to compare. */
  continuations: number;
  lastContinuation: { thinking: unknown; blocks: unknown[]; counted: boolean } | null;
} = { requests: 0, disconnected: 0, audioWav: 0, audioMp3: 0, continuations: 0, lastContinuation: null };
/** The reviewed manual-thinking contract the fixture enforces on Anthropic
 * bodies that carry thinking: budget 1,024..max_tokens-1, no temperature,
 * top-p within 0.95–1, and assistant thinking blocks first with signatures. */
function continuationIssue(body: any): string | null {
  if (body.thinking !== undefined) {
    const thinking = body.thinking;
    if (!thinking || thinking.type !== "enabled" || !Number.isSafeInteger(thinking.budget_tokens) || thinking.budget_tokens < 1024 ||
        !("max_tokens" in body ? thinking.budget_tokens < body.max_tokens : true) || "temperature" in body ||
        ("top_p" in body && !(body.top_p >= 0.95 && body.top_p <= 1)))
      return "Malformed thinking parameter";
  }
  for (const message of body.messages ?? []) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    let reasoning = true;
    for (const block of message.content) {
      const isReasoning = block?.type === "thinking" || block?.type === "redacted_thinking";
      if (isReasoning && !reasoning) return "Thinking block after other content";
      if (!isReasoning) reasoning = false;
      if (block?.type === "thinking" && (typeof block.thinking !== "string" || typeof block.signature !== "string" || !block.signature || Object.keys(block).length !== 3)) return "Unsigned or extended thinking block";
      if (block?.type === "redacted_thinking" && (typeof block.data !== "string" || !block.data || Object.keys(block).length !== 2)) return "Malformed redacted block";
    }
  }
  return null;
}
function recordContinuation(body: any, counted: boolean) {
  const blocks = (body.messages ?? []).filter((message: any) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message: any) => message.content.filter((block: any) => block?.type === "thinking" || block?.type === "redacted_thinking"));
  if (body.thinking === undefined && !blocks.length) return;
  fixtureStats.continuations++;
  fixtureStats.lastContinuation = { thinking: body.thinking ?? null, blocks, counted };
}
/** Loopback fixture only: synthetic body mode selects fixed SSE transcripts. */
export function providerFixture(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void = () => {
    res.statusCode = 404;
    res.end();
  },
): void {
  if (req.url === "/fixture-stats") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(fixtureStats));
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (
    !["/v1/models", "/v1/messages", "/v1/chat/completions", "/v1/messages/count_tokens"].includes(
      url.pathname,
    )
  ) {
    next();
    return;
  }
  const protocol =
    url.pathname === "/v1/messages" || req.headers["anthropic-version"]
      ? "anthropic"
      : "openai-compatible";
  const authorized =
    protocol === "anthropic"
      ? req.headers["x-api-key"] === "synthetic-secret" &&
        req.headers["anthropic-version"] === "2023-06-01"
      : req.headers.authorization === "Bearer synthetic-secret";
  if (!authorized) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      '{"error":{"type":"authentication_error","message":"Synthetic fixture binding failed"}}',
    );
    return;
  }
  fixtureStats.requests++;
  if (url.pathname === "/v1/models") {
    res.setHeader("content-type", "application/json");
    // Anthropic pages by after_id; the second page carries the reviewed
    // model so discovery must follow the cursor to find it. The OpenAI list
    // is flat and unpaged.
    const reviewed =
      protocol === "anthropic"
        ? "claude-haiku-4-5-20251001"
        : "gpt-4.1-mini-2025-04-14";
    res.end(
      JSON.stringify(
        protocol === "anthropic"
          ? url.searchParams.get("after_id") === "unknown-model"
            ? {
                data: [{ id: reviewed, display_name: "Reviewed fixture model" }],
                has_more: false,
                first_id: reviewed,
                last_id: reviewed,
              }
            : {
                data: [{ id: "synthetic-model" }, { id: "unknown-model" }],
                has_more: url.searchParams.has("limit"),
                first_id: "synthetic-model",
                last_id: "unknown-model",
              }
          : {
              object: "list",
              data: [
                { id: "synthetic-model" },
                { id: "unknown-model" },
                { id: reviewed },
              ],
            },
      ),
    );
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      // The documented count endpoint: model, system, messages and tools only.
      if ("stream" in body || "max_tokens" in body || !Array.isArray(body.messages) || continuationIssue(body)) {
        res.statusCode = 400;
        res.end("Malformed count request");
        return;
      }
      recordContinuation(body, true);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: JSON.stringify(body.messages).length }));
      return;
    }
    if (
      body.stream !== true ||
      (protocol === "anthropic" &&
        ((body.max_tokens !== 100 && !(body.thinking !== undefined && body.max_tokens === 2048)) || body.system !== "Synthetic system")) ||
      (protocol === "anthropic" && continuationIssue(body)) ||
      (protocol === "openai-compatible" &&
        (body.max_completion_tokens !== 100 ||
          body.store !== false ||
          body.stream_options?.include_usage !== true))
    ) {
      res.statusCode = 400;
      res.end("Malformed fixture request");
      return;
    }
    if (protocol === "anthropic") recordContinuation(body, false);
    if (body.model === "gpt-audio-1.5") {
      const blocks = body.messages?.filter((message: any) => message.role === "user").flatMap((message: any) => message.content) ?? [];
      const audio = blocks.filter((part: any) => part?.type === "input_audio");
      const format = audio[0]?.input_audio?.format;
      if (protocol !== "openai-compatible" || JSON.stringify(body.modalities) !== '["text"]' || body.audio !== undefined || audio.length !== 1 ||
          !["wav", "mp3"].includes(format) || audio[0].input_audio.data !== Buffer.from(audioFixture(format)).toString("base64")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":{"message":"Exact original audio and text-only output required"}}'); return;
      }
      if (format === "wav") fixtureStats.audioWav++; else fixtureStats.audioMp3++;
    }
    if (body.model === "rate") {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "2",
      });
      res.end(
        '{"error":{"type":"rate_limit_error","message":"Synthetic rate limit"}}',
      );
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-request-id": "synthetic-request",
    });
    const mode =
      body.model === "synthetic-model" || body.model === "delayed" || body.model === "gpt-audio-1.5"
        ? "complete"
        : body.model;
    const stream = Buffer.from(fixture(protocol, mode));
    let offset = 0;
    // Actual TCP chunks split UTF-8 and SSE JSON at unrelated byte offsets.
    const timer = setInterval(
      () => {
        if (res.destroyed) {
          clearInterval(timer);
          return;
        }
        if (offset >= stream.length) {
          clearInterval(timer);
          if (mode !== "slow") res.end();
          return;
        }
        const end = Math.min(
          stream.length,
          offset + (body.model === "delayed" ? 80 : 137),
        );
        res.write(stream.subarray(offset, end));
        offset = end;
      },
      body.model === "delayed" ? 75 : 2,
    );
    res.on("close", () => {
      clearInterval(timer);
      if (mode === "slow" || offset < stream.length)
        fixtureStats.disconnected++;
    });
  });
}
