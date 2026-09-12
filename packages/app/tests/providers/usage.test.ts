import test from "node:test";
import assert from "node:assert/strict";
import {
  describeAttemptUsage,
  describeThreadUsage,
  formatCostAmount,
} from "../../src/runtime/usage.ts";

test("cost amounts drop trailing zeros without rounding and keep two decimals", () => {
  assert.equal(formatCostAmount("0.000112000"), "0.000112");
  assert.equal(formatCostAmount("1.500000000"), "1.50");
  assert.equal(formatCostAmount("0.000000000"), "0.00");
  assert.equal(formatCostAmount("12"), "12.00");
  assert.equal(formatCostAmount("odd"), "odd");
});

test("an attempt line names reported cost, reviewed estimates and unknowns", () => {
  const base = { tokensIn: 12, tokensOut: 20, cachedTokens: 0, estimatedCost: null, reportedCost: null };
  assert.equal(describeAttemptUsage(base), "Tokens in: 12 · out: 20 · Cost: unknown");
  assert.equal(
    describeAttemptUsage({ ...base, cachedTokens: 5, estimatedCost: { amount: "0.000112000", currency: "USD" } }),
    "Tokens in: 12 (5 cached) · out: 20 · Cost: ≈ 0.000112 USD estimated from reviewed pricing",
  );
  assert.equal(
    describeAttemptUsage({ ...base, reportedCost: { amount: "0.010000000", currency: "USD" }, estimatedCost: { amount: "0.000112000", currency: "USD" } }),
    "Tokens in: 12 · out: 20 · Cost: 0.01 USD reported by the provider",
  );
  assert.equal(describeAttemptUsage({ ...base, tokensIn: null, tokensOut: null, cachedTokens: null }), "Tokens in: unknown · out: unknown · Cost: unknown");
});

test("conversation totals name attempts, tokens, priced and unpriced attempts", () => {
  assert.equal(
    describeThreadUsage({ attempts: 0, tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null, unpricedAttempts: 0 }),
    "No attempts yet.",
  );
  assert.equal(
    describeThreadUsage({ attempts: 3, tokensIn: 36, tokensOut: 40, cachedTokens: 0, estimatedCost: { amount: "0.000224", currency: "USD", attempts: 2 }, unpricedAttempts: 1 }),
    "3 attempts · tokens in 36 · out 40 · estimated ≈ 0.000224 USD across 2 priced attempts, 1 without a price",
  );
  assert.equal(
    describeThreadUsage({ attempts: 1, tokensIn: 12, tokensOut: null, cachedTokens: 4, estimatedCost: null, unpricedAttempts: 1 }),
    "1 attempt · tokens in 12 (4 cached) · out unknown · no price estimate",
  );
});

test('conversation totals identify the included summary attempts and their own usage', () => {
  const summary = { attempts: 1, tokensIn: 120, tokensOut: 40, cachedTokens: null, estimatedCost: { amount: '0.002', currency: 'USD', attempts: 1 }, unpricedAttempts: 0 };
  const line = describeThreadUsage({ attempts: 4, tokensIn: 360, tokensOut: 140, cachedTokens: null, estimatedCost: null, unpricedAttempts: 2, summary });
  assert.match(line, /^4 attempts/);
  assert.match(line, /Summary proposals \(included above\): 1 attempt · tokens in 120 · out 40 · estimated ≈ 0.002 USD across 1 priced attempt$/);
});
