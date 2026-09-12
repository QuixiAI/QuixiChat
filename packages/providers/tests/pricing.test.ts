import test from "node:test";
import assert from "node:assert/strict";
import {
  adapterCatalog,
  createAnthropicAdapter,
  createOpenAICompatibleAdapter,
  initialProviderCatalogs,
} from "../src/index.ts";
import type { HostClient } from "@quixi/core/contracts";

const reviewedAt = Date.parse("2026-09-09T00:00:00Z");
const usage = (inputTokens: number, outputTokens: number, cached = 0) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  reasoningTokens: null,
  raw: {},
  source: "provider" as const,
});

test("both reviewed catalog entries carry dated pricing from the provider's published rates", () => {
  for (const catalog of initialProviderCatalogs()) {
    const pricing = catalog.model.pricing;
    assert.ok(pricing, catalog.providerId);
    assert.equal(pricing.currency, "USD");
    assert.equal(pricing.verifiedAt, reviewedAt);
    assert.ok(catalog.review.sources.includes(pricing.sourceUrl), "the pricing source is a reviewed source");
    assert.ok(catalog.limitations.some((line) => line.includes("not bills")), "estimates are labelled as estimates");
  }
  const [openai, anthropic] = initialProviderCatalogs();
  assert.deepEqual(
    { ...openai!.model.pricing, sourceUrl: "" },
    { currency: "USD", inputPerMillion: "0.40", outputPerMillion: "1.60", cachedInputPerMillion: "0.10", cacheWriteInputPerMillion: null, sourceUrl: "", verifiedAt: reviewedAt },
  );
  assert.deepEqual(
    { ...anthropic!.model.pricing, sourceUrl: "" },
    { currency: "USD", inputPerMillion: "1", outputPerMillion: "5", cachedInputPerMillion: "0.10", cacheWriteInputPerMillion: "1.25", sourceUrl: "", verifiedAt: reviewedAt },
  );
});

test("estimates follow the reviewed rates exactly and stay unknown without cache accounting", () => {
  const host = {} as HostClient;
  const [openai, anthropic] = initialProviderCatalogs();
  const binding = (providerId: string) => ({ providerId, accountId: "primary", destinationId: providerId, transportId: providerId });
  const credential = (providerId: string) => ({ id: crypto.randomUUID(), persistence: "session" as const, binding: binding(providerId) });
  const claude = createAnthropicAdapter({ host, binding: binding("anthropic"), credential: credential("anthropic"), catalog: adapterCatalog(anthropic!), nextId: () => crypto.randomUUID(), now: Date.now });
  const gpt = createOpenAICompatibleAdapter({ host, binding: binding("openai"), credential: credential("openai"), catalog: adapterCatalog(openai!), nextId: () => crypto.randomUUID(), now: Date.now });
  // 12 input tokens at $1/MTok plus 20 output tokens at $5/MTok.
  assert.deepEqual(claude.estimateCost("claude-haiku-4-5-20251001", usage(12, 20)).cost, { amount: "0.000112000", currency: "USD" });
  // 12 input tokens at $0.40/MTok plus 20 output tokens at $1.60/MTok.
  assert.deepEqual(gpt.estimateCost("gpt-4.1-mini-2025-04-14", usage(12, 20)).cost, { amount: "0.000036800", currency: "USD" });
  // 1,000 cached of 1,200 input tokens at the cache-read rate.
  assert.deepEqual(claude.estimateCost("claude-haiku-4-5-20251001", usage(1200, 0, 1000)).cost, { amount: "0.000300000", currency: "USD" });
  assert.equal(claude.estimateCost("claude-haiku-4-5-20251001", { ...usage(12, 20), cachedInputTokens: null }).cost, null);
  assert.equal(gpt.estimateCost("unknown-model", usage(12, 20)).cost, null);
});
