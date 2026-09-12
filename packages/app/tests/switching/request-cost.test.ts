import test from "node:test";
import assert from "node:assert/strict";
import type { Pricing } from "@quixi/providers";
import { assessRequestCost, type RequestCostInput } from "../../src/runtime/request-cost.ts";

const pricing: Pricing = {
  currency: "USD", inputPerMillion: "1", outputPerMillion: "5",
  cachedInputPerMillion: "0.1", cacheWriteInputPerMillion: "1.25",
  sourceUrl: "https://example.test/pricing", verifiedAt: 1,
};
const base: RequestCostInput = {
  requirements: { maxEstimatedRequestCost: "0.20512" }, pricing,
  contextWindow: 200_000, maxOutputTokens: 1_024,
};

test("the uncounted conservative bound includes the entire input window and maximum output", () => {
  const result = assessRequestCost(base);
  assert.equal(result.allowed, true);
  assert.equal(result.basis, "context_bound");
  assert.equal(result.inputAmount, "0.2");
  assert.equal(result.totalAmount, "0.20512");
  assert.match(result.reason, /Conservative context bound/);
  const lower = assessRequestCost({ ...base, requirements: { maxEstimatedRequestCost: "0.205119999" } });
  assert.equal(lower.allowed, false);
  assert.match(lower.reason, /per-attempt limit/);
});

test("a bound count permits a cheaper estimate without assuming a cache discount", () => {
  const result = assessRequestCost({ ...base, countedInputTokens: 2_000, requirements: { maxEstimatedRequestCost: "0.00712" } });
  assert.equal(result.allowed, true);
  assert.equal(result.basis, "counted");
  assert.equal(result.inputAmount, "0.002");
  assert.equal(result.totalAmount, "0.00712");
  assert.match(result.reason, /Counted input estimate/);
  assert.deepEqual(result, assessRequestCost({ ...base, countedInputTokens: 2_000, requirements: { maxEstimatedRequestCost: "0.00712" }, pricing: { ...pricing, cachedInputPerMillion: "0", cacheWriteInputPerMillion: "garbage" } }));
});

test("nanodollar rounding compares exact decimal boundaries and rounds combined cost once", () => {
  const input = { ...base, pricing: { ...pricing, inputPerMillion: "0.0001", outputPerMillion: "0.0001" }, countedInputTokens: 1, maxOutputTokens: 1 };
  const exact = assessRequestCost({ ...input, requirements: { maxRequestCost: "0.000000001", maxEstimatedRequestCost: "0.000000001" } });
  assert.equal(exact.allowed, true);
  assert.equal(exact.inputAmount, "0.000000001");
  assert.equal(exact.totalAmount, "0.000000001");
  assert.equal(assessRequestCost({ ...input, requirements: { maxEstimatedRequestCost: "0" } }).allowed, false);
  const boundary = assessRequestCost({ ...base, pricing: { ...pricing, inputPerMillion: "0.1", outputPerMillion: "0.2" }, countedInputTokens: 1_000_000, maxOutputTokens: 1_000_000, contextWindow: 1_000_000, requirements: { maxEstimatedRequestCost: "0.3" } });
  assert.equal(boundary.allowed, true);
  assert.equal(boundary.totalAmount, "0.3");
});

test("legacy input-only and total attempt limits are both enforced independently", () => {
  const input = { ...base, countedInputTokens: 2_000 };
  assert.equal(assessRequestCost({ ...input, requirements: { maxRequestCost: "0.002" } }).allowed, true);
  const oldCap = assessRequestCost({ ...input, requirements: { maxRequestCost: "0.001999999", maxEstimatedRequestCost: "1" } });
  assert.equal(oldCap.allowed, false);
  assert.match(oldCap.reason, /input limit/);
  const totalCap = assessRequestCost({ ...input, requirements: { maxRequestCost: "1", maxEstimatedRequestCost: "0.007119999" } });
  assert.equal(totalCap.allowed, false);
  assert.match(totalCap.reason, /maximum output/);
});

test("missing or malformed price information and unsupported currency refuse capped attempts", () => {
  for (const candidate of [null, { ...pricing, currency: "EUR" }, { ...pricing, currency: "usd" }, ...["", "-1", "1e2", "NaN", "Infinity", "1.0000000001", "1000000000", " 1", ".1"].flatMap((value) => [{ ...pricing, inputPerMillion: value }, { ...pricing, outputPerMillion: value }])]) {
    const result = assessRequestCost({ ...base, pricing: candidate });
    assert.equal(result.allowed, false, JSON.stringify(candidate));
    assert.equal(result.basis, "unavailable");
    assert.equal(result.totalAmount, null);
  }
});

test("invalid cost limits fail closed, including old input-only limits", () => {
  for (const value of ["", "-1", "1e2", "NaN", "Infinity", "1.0000000001", "1000000000", " 1", ".1", 1, null]) {
    for (const key of ["maxRequestCost", "maxEstimatedRequestCost"])
      assert.equal(assessRequestCost({ ...base, requirements: { [key]: value } as RequestCostInput["requirements"] }).allowed, false, `${key}: ${value}`);
  }
});

test("invalid counts and output or context limits cannot satisfy a configured cap", () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(assessRequestCost({ ...base, countedInputTokens: value }).allowed, false, `count ${value}`);
  assert.match(assessRequestCost({ ...base, countedInputTokens: 200_001 }).reason, /exceeds the declared context window/);
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(assessRequestCost({ ...base, maxOutputTokens: value }).allowed, false, `output ${value}`);
    assert.equal(assessRequestCost({ ...base, contextWindow: value }).allowed, false, `window ${value}`);
  }
});

test("an unknown context requires a valid count; null counts use the conservative bound", () => {
  assert.equal(assessRequestCost({ ...base, contextWindow: null }).allowed, false);
  assert.equal(assessRequestCost({ ...base, contextWindow: null, countedInputTokens: null }).allowed, false);
  assert.equal(assessRequestCost({ ...base, contextWindow: null, countedInputTokens: 10 }).allowed, true);
  assert.equal(assessRequestCost({ ...base, countedInputTokens: null }).basis, "context_bound");
});

test("zero caps accept only zero relevant cost and zero counts remain counted evidence", () => {
  const inputOnly = assessRequestCost({ ...base, countedInputTokens: 0, requirements: { maxRequestCost: "0" } });
  assert.equal(inputOnly.allowed, true);
  assert.equal(inputOnly.basis, "counted");
  assert.equal(inputOnly.inputAmount, "0");
  assert.equal(inputOnly.totalAmount, "0.00512");
  assert.equal(assessRequestCost({ ...base, countedInputTokens: 0, requirements: { maxEstimatedRequestCost: "0" } }).allowed, false);
  assert.equal(assessRequestCost({ ...base, pricing: { ...pricing, inputPerMillion: "0", outputPerMillion: "0" }, requirements: { maxEstimatedRequestCost: "0" } }).allowed, true);
});

test("uncapped requests do not require pricing, counts, or valid estimate-only limits", () => {
  assert.deepEqual(assessRequestCost({ requirements: {}, pricing: null, contextWindow: null, maxOutputTokens: 0, countedInputTokens: NaN }), {
    allowed: true, reason: "No request cost limit configured", inputAmount: null, totalAmount: null, basis: "unavailable",
  });
});

test("large safe token budgets retain exact precision with nine-place rates", () => {
  const result = assessRequestCost({ ...base, countedInputTokens: Number.MAX_SAFE_INTEGER, contextWindow: Number.MAX_SAFE_INTEGER, maxOutputTokens: 1, pricing: { ...pricing, inputPerMillion: "0.000000001", outputPerMillion: "0.000000001" }, requirements: { maxEstimatedRequestCost: "9.007199255" } });
  assert.equal(result.allowed, true);
  assert.equal(result.inputAmount, "9.007199255");
  assert.equal(result.totalAmount, "9.007199255");
});
