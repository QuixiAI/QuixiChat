import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createWebHost } from "../../../apps/web/src/host/index.ts";
import {
  createOpenAICompatibleAdapter,
  createAnthropicAdapter,
  Normalizer,
  SSEDecoder,
  CompatibilityError,
  LIMITS,
  type Protocol,
  type ProviderEvent,
} from "../src/index.ts";
import { fixture, model, input, chat, sse } from "./fixtures.ts";
const encode = (value: string) => new TextEncoder().encode(value);
function normalize(protocol: Protocol, text: string, step = 1) {
  const parser = new SSEDecoder(),
    normalizer = new Normalizer(protocol),
    events: ProviderEvent[] = [];
  const bytes = encode(text);
  for (let i = 0; i < bytes.length; i += step)
    for (const record of parser.push(
      bytes.slice(i, i + step),
      i + step >= bytes.length,
    ))
      events.push(...normalizer.accept(record));
  return { events, normalizer };
}
for (const protocol of ["openai-compatible", "anthropic"] as const) {
  test(`${protocol}: byte-fragmented UTF-8, tools, citations, raw-only unknown outputs and cumulative usage`, () => {
    const { events, normalizer: n } = normalize(protocol, fixture(protocol));
    assert.equal(n.ended, true);
    assert.equal(n.terminalStatus(), "complete");
    assert.equal(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
      protocol === "anthropic" ? "Hello 🧪 " : "Hello 🧪 done",
    );
    const tool = events.find(
      (e) => e.type === "part" && e.part.kind === "ToolCall",
    );
    assert.ok(tool?.type === "part" && tool.part.kind === "ToolCall");
    assert.deepEqual(tool.part.data.input, { q: "fixture" });
    assert.ok(
      events.some((e) => e.type === "part" && e.part.kind === "Citation"),
    );
    assert.ok(events.some((e) => e.type === "artifact"));
    assert.equal(n.usage.outputTokens, 7);
    assert.equal(n.usage.inputTokens, protocol === "anthropic" ? 18 : 20);
    assert.equal(n.usage.cachedInputTokens, 4);
    if (protocol === "anthropic")
      assert.ok(
        events.some(
          (e) => e.type === "part" && e.part.kind === "ReasoningMetadata",
        ),
      );
  });
  test(`${protocol}: explicit limit stop and terminal truncation differ`, () => {
    assert.equal(
      normalize(
        protocol,
        fixture(protocol, "limited"),
      ).normalizer.terminalStatus(),
      "stopped",
    );
    assert.equal(
      normalize(protocol, fixture(protocol, "truncated")).normalizer.ended,
      false,
    );
    assert.throws(
      () => normalize(protocol, fixture(protocol, "malformed")),
      /malformed JSON/,
    );
  });
}
test("SSE bounds include fragmented Unicode and unterminated records", () => {
  assert.throws(
    () =>
      normalize(
        "openai-compatible",
        "data: " + "🧪".repeat(LIMITS.eventBytes / 4 + 1),
      ),
    /framing limit/,
  );
  assert.throws(
    () => [...new SSEDecoder().push(encode("data: {}"), true)],
    /inside an SSE/,
  );
  assert.throws(
    () => [...new SSEDecoder().push(new Uint8Array([255]), true)],
    /UTF-8/,
  );
  assert.throws(
    () =>
      normalize(
        "openai-compatible",
        sse(chat({ content: "x" })) + sse("[DONE]"),
      ),
    /finish reason/,
  );
  assert.throws(
    () =>
      normalize(
        "openai-compatible",
        sse(chat({ content: "x" })) + sse({ ...chat({}, "stop"), id: "other" }),
      ),
    /identity changed/,
  );
});
test("tool JSON, depth and byte limits fail without fabricating a complete tool", () => {
  assert.throws(
    () =>
      normalize(
        "openai-compatible",
        sse(
          chat(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "x",
                  function: { name: "lookup", arguments: "bad" },
                },
              ],
            },
            "tool_calls",
          ),
        ),
      ),
    /malformed JSON/,
  );
  let text = sse(
    chat({
      tool_calls: [
        { index: 0, id: "x", function: { name: "lookup", arguments: '"' } },
      ],
    }),
  );
  for (let i = 0; i < 5; i++)
    text += sse(
      chat({
        tool_calls: [{ index: 0, function: { arguments: "🧪".repeat(16384) } }],
      }),
    );
  assert.throws(
    () => normalize("openai-compatible", text, 65536),
    /buffer limit/,
  );
});

test("controlled HTTP: bindings, request bodies, stream cleanup, error health, cancellation, compatibility and cost", async () => {
  const requests: {
    path: string;
    body: any;
    auth: string | undefined;
    version: string | undefined;
  }[] = [];
  let disconnected = false;
  const listings: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    requests.push({
      path: req.url!,
      body,
      auth:
        req.headers.authorization ??
        (req.headers["x-api-key"] as string | undefined),
      version: req.headers["anthropic-version"] as string | undefined,
    });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/v1/messages/count_tokens") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify("stream" in body || "max_tokens" in body ? { error: "generation fields" } : { input_tokens: 42 }));
      return;
    }
    if (url.pathname === "/v1/models") {
      res.setHeader("content-type", "application/json");
      listings.push(url.search);
      res.end(
        JSON.stringify(
          url.searchParams.get("after_id") === "unknown"
            ? { data: [{ id: "paged" }], has_more: false, last_id: "paged" }
            : {
                data: [{ id: "synthetic-model" }, { id: "unknown" }],
                has_more: true,
                last_id: "unknown",
              },
        ),
      );
      return;
    }
    if (body.model === "rate") {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "2",
      });
      res.end(
        JSON.stringify({
          error: { type: "rate_limit_error", message: "Synthetic limit" },
        }),
      );
      return;
    }
    const protocol =
      req.url === "/v1/messages" ? "anthropic" : "openai-compatible";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      fixture(
        protocol,
        body.model === "synthetic-model" ? "complete" : body.model,
      ),
    );
    if (body.model === "slow") {
      res.on("close", () => {
        disconnected = true;
      });
    } else res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (const protocol of ["openai-compatible", "anthropic"] as const) {
      const binding = {
        providerId: protocol,
        accountId: "synthetic-account",
        destinationId: protocol,
        transportId: "local-fixture",
      };
      const host = createWebHost({
        destinations: [
          {
            binding,
            baseUrl: `http://127.0.0.1:${port}`,
            allowInsecureLoopback: true,
            routes: ["/v1/models", "/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens"].map(
              (path) => ({
                path,
                methods: ["GET", "POST"],
                headers: ["content-type", "anthropic-version"],
                ...(path === "/v1/models" && protocol === "anthropic"
                  ? { query: ["after_id", "before_id", "limit"] }
                  : {}),
              }),
            ),
            credential: {
              header: protocol === "anthropic" ? "x-api-key" : "Authorization",
              prefix: protocol === "anthropic" ? "" : "Bearer ",
            },
            transport: {
              kind: "browser_direct",
              privacy: "local",
              relayIdentity: null,
            },
          },
        ],
      });
      try {
        const credential = await host.storeSecret(
          crypto.randomUUID(),
          binding,
          encode("synthetic-secret"),
          null,
        );
        const factory =
          protocol === "anthropic"
            ? createAnthropicAdapter
            : createOpenAICompatibleAdapter;
        const finishedStages: string[] = [], releasedStages: string[] = [];
        const observedHost = { ...host,
          async finishTransfer(...args: Parameters<typeof host.finishTransfer>) { const result = await host.finishTransfer(...args); finishedStages.push(args[1]); return result; },
          async releaseTransfer(...args: Parameters<typeof host.releaseTransfer>) { const result = await host.releaseTransfer(...args); releasedStages.push(args[1]); return result; },
        };
        const adapter = factory({
          host: observedHost,
          binding,
          credential,
          catalog: [
            "synthetic-model",
            "malformed",
            "truncated",
            "slow",
            "rate",
          ].map((id) => model(protocol, id)),
          nextId: () => crypto.randomUUID(),
          now: () => 1000,
        });
        listings.length = 0;
        const listing = await adapter.listModels();
        assert.equal(listing.complete, false);
        assert.equal(listing.models[1]!.capabilities.streaming, "unknown");
        if (protocol === "anthropic") {
          assert.equal(listing.nextCursor, "unknown");
          assert.deepEqual(listings, ["?limit=1000"]);
          const next = await adapter.listModels(listing.nextCursor);
          assert.equal(next.complete, true);
          assert.equal(next.nextCursor, null);
          assert.deepEqual(next.models.map((value) => value.id), ["paged"]);
          assert.deepEqual(listings, ["?limit=1000", "?limit=1000&after_id=unknown"]);
        } else {
          assert.equal(listing.nextCursor, null);
          assert.deepEqual(listings, [""]);
        }
        assert.equal((await adapter.authenticate()).status, "healthy");
        for (const mode of ["synthetic-model", "malformed", "truncated"]) {
          let terminal;
          let output = "";
          for await (const event of adapter.stream(input(mode)).events) {
            if (event.type === "text") output += event.text;
            if (event.type === "terminal") terminal = event;
          }
          assert.equal(
            terminal?.status,
            mode === "synthetic-model" ? "complete" : "partial",
          );
          assert.ok(output.startsWith("Hello 🧪 "));
        }
        const rate = [];
        for await (const e of adapter.stream(input("rate")).events)
          rate.push(e);
        assert.equal(rate.at(-1)?.type, "terminal");
        assert.equal(adapter.accountHealth().status, "rate_limited");
        assert.equal(adapter.accountHealth().retryAt, 3000);
        const slow = adapter.stream(input("slow"));
        let terminal;
        for await (const event of slow.events) {
          if (event.type === "text") await slow.cancel();
          if (event.type === "terminal") terminal = event;
        }
        assert.equal(terminal?.status, "cancelled");
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(disconnected, true);
        const cancelBefore = adapter.stream(input());
        assert.equal(
          (await cancelBefore.cancel()).externalEffect,
          "not_dispatched",
        );
        const before = requests.length;
        for await (const e of cancelBefore.events)
          assert.equal(e.type, "terminal");
        assert.equal(requests.length, before);
        const deniedHttp = requests.length, deniedStages = finishedStages.length;
        let guardCalls = 0;
        const denied = adapter.stream(input(), async () => {
          guardCalls++; assert.equal(finishedStages.length, deniedStages + 1, 'the guard runs after the request body is staged');
          assert.equal(requests.length, deniedHttp); throw new Error('Policy changed after staging');
        });
        const deniedEvents: ProviderEvent[] = [];
        for await (const event of denied.events) deniedEvents.push(event);
        assert.equal(guardCalls, 1); assert.equal(requests.length, deniedHttp);
        assert.equal(deniedEvents.at(-1)?.type, 'terminal');
        const deniedTerminal = deniedEvents.at(-1);
        assert(deniedTerminal?.type === 'terminal'); assert.equal(deniedTerminal.status, 'failed'); assert.equal(deniedTerminal.error?.code, 'transport');
        assert(releasedStages.includes(finishedStages.at(-1)!), 'a denied request releases its staged body');
        let enterGuard!: () => void, releaseGuard!: () => void;
        const enteredGuard = new Promise<void>(resolve => { enterGuard = resolve; }), guardGate = new Promise<void>(resolve => { releaseGuard = resolve; });
        const waiting = adapter.stream(input(), async () => { enterGuard(); await guardGate; });
        const waitingEvents = (async () => { const values: ProviderEvent[] = []; for await (const value of waiting.events) values.push(value); return values; })();
        await enteredGuard;
        assert.equal((await waiting.cancel()).externalEffect, 'not_dispatched'); releaseGuard();
        const cancelledEvents = await waitingEvents;
        const cancelledTerminal = cancelledEvents.at(-1); assert(cancelledTerminal?.type === 'terminal'); assert.equal(cancelledTerminal.status, 'cancelled');
        assert.equal(requests.length, deniedHttp); assert(releasedStages.includes(finishedStages.at(-1)!));
        let successfulGuards = 0;
        const successfulEvents: ProviderEvent[] = [];
        for await (const event of adapter.stream(input(), async () => { successfulGuards++; assert.equal(requests.length, deniedHttp); }).events) successfulEvents.push(event);
        assert.equal(successfulGuards, 2, 'adapter and host both recheck before dispatch'); assert.equal(requests.length, deniedHttp + 1);
        const successfulTerminal = successfulEvents.at(-1); assert(successfulTerminal?.type === 'terminal'); assert.equal(successfulTerminal.status, 'complete');
        const bad = input();
        bad.messages = [
          {
            role: "user",
            parts: [
              {
                id: crypto.randomUUID(),
                messageId: crypto.randomUUID(),
                order: 0,
                kind: "Image",
                data: { attachmentId: crypto.randomUUID(), description: null },
              },
            ],
          },
        ];
        assert.throws(() => adapter.prepare(bad), CompatibilityError);
        assert.throws(
          () => adapter.prepare(input("unregistered")),
          CompatibilityError,
        );
        let countGuards = 0;
        const beforeCount = requests.length, beforeCountStages = finishedStages.length;
        const refusedCount = await adapter.countTokens(input(), async () => { countGuards++; assert.equal(finishedStages.length, beforeCountStages + 1); throw new Error('Count policy changed after staging'); });
        assert.equal(refusedCount.tokens, null); assert.equal(requests.length, beforeCount);
        if (protocol === 'anthropic') { assert.equal(countGuards, 1); assert(refusedCount.reason); assert(releasedStages.includes(finishedStages.at(-1)!)); }
        else { assert.equal(countGuards, 0); assert.equal(finishedStages.length, beforeCountStages); }
        let successfulCountGuards = 0;
        const counted = await adapter.countTokens(input(), async () => { successfulCountGuards++; assert.equal(requests.length, beforeCount); });
        if (protocol === "anthropic") {
          assert.equal(counted.tokens, 42);
          assert.equal(successfulCountGuards, 2, 'adapter and host both recheck counting before dispatch');
          assert.equal(counted.source, "provider");
          const countRequest = requests.find((item) => item.path === "/v1/messages/count_tokens")!;
          assert.equal(countRequest.body.model, "synthetic-model");
          assert.equal("stream" in countRequest.body, false);
          assert.equal("max_tokens" in countRequest.body, false);
          assert.equal(countRequest.version, "2023-06-01");
        } else {
          assert.equal(counted.tokens, null);
          assert.equal(successfulCountGuards, 0);
          assert.match(counted.reason ?? "", /not implemented for this Chat Completions connection/);
        }
        const usage = {
          inputTokens: 20,
          outputTokens: 7,
          cachedInputTokens: 4,
          cacheWriteInputTokens: 0,
          reasoningTokens: null,
          raw: {},
          source: "provider" as const,
        };
        assert.equal(
          adapter.estimateCost("synthetic-model", usage).cost?.amount,
          "0.000090000",
        );
        assert.equal(
          adapter.estimateCost("synthetic-model", {
            ...usage,
            cachedInputTokens: null,
          }).cost,
          null,
        );
        const actual = requests.find(
          (item) =>
            item.body.model === "synthetic-model" &&
            item.path ===
              (protocol === "anthropic"
                ? "/v1/messages"
                : "/v1/chat/completions"),
        )!;
        assert.equal(
          actual.auth,
          protocol === "anthropic"
            ? "synthetic-secret"
            : "Bearer synthetic-secret",
        );
        assert.equal(actual.body.stream, true);
        if (protocol === "anthropic") {
          assert.equal(actual.version, "2023-06-01");
          assert.equal(actual.body.max_tokens, 100);
          assert.equal(actual.body.system, "Synthetic system");
        } else {
          assert.equal(actual.body.store, false);
          assert.equal(actual.body.stream_options.include_usage, true);
          assert.equal(actual.body.max_completion_tokens, 100);
        }
      } finally {
        await host.dispose();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("framing byte cap includes line endings and structural bounds include queued nodes", () => {
  assert.throws(
    () =>
      normalize(
        "openai-compatible",
        ":\r\n".repeat(Math.ceil(LIMITS.eventBytes / 3)),
        65536,
      ),
    /framing limit/,
  );
  assert.throws(
    () =>
      normalize(
        "openai-compatible",
        sse(chat({ content: "x", unknown: Array(20001).fill(null) })),
        65536,
      ),
    /structure exceeds/,
  );
});

test("usage metadata cannot grow without bound across otherwise small records", () => {
  const first = {
    ...chat({ content: "retained" }),
    usage: { prompt_tokens: 2, completion_tokens: 1, first: "x".repeat(40000) },
  };
  const second = { ...chat({}), usage: { second: "y".repeat(40000) } };
  assert.throws(
    () => normalize("openai-compatible", sse(first) + sse(second), 65536),
    /usage metadata exceeds/,
  );
});
