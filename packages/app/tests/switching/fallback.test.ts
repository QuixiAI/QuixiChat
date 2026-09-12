import test from "node:test";
import assert from "node:assert/strict";
import type { CompatibilityReport } from "@quixi/providers";
import {
  evaluateFallback,
  parseFallbackPolicy,
  routingProfileWith,
  type FallbackCandidate,
} from "../../src/runtime/fallback.ts";

const policy = { provider: "openai", model: "gpt", allowPrivacyChange: false };
const primary = { label: "Anthropic", provider: "anthropic", model: "claude", privacy: "direct_provider" };
const healthy = { blocksSending: false, label: "Healthy", detail: null };
const candidate = (overrides: Partial<FallbackCandidate> = {}): FallbackCandidate => ({
  provider: { id: "openai", label: "OpenAI", privacy: "direct_provider" },
  model: { id: "gpt", name: "GPT-4.1 mini" },
  health: healthy,
  ...overrides,
});
const report = (overrides: Partial<CompatibilityReport> = {}): CompatibilityReport => ({
  target: { protocol: "openai-compatible", modelId: "gpt" },
  preserved: { parts: 2, byKind: { Text: 2 } },
  blocked: [],
  constraints: [],
  requestBytes: 400,
  sendable: true,
  context: { contextWindow: 1_000, maxOutputTokens: 100, inputRoom: 900 },
  pricing: null,
  ...overrides,
});
const failed = { status: "failed", code: "provider_error", message: "Synthetic overload" };

test("the routing profile round-trips a fallback and rejects other shapes", () => {
  const profile = routingProfileWith(null, policy);
  assert.deepEqual(profile, { version: 1, fallback: policy });
  assert.deepEqual(parseFallbackPolicy(profile), policy);
  assert.equal(parseFallbackPolicy(null), null);
  assert.equal(parseFallbackPolicy({ version: 2, fallback: policy }), null);
  assert.equal(parseFallbackPolicy({ version: 1, fallback: { provider: "", model: "x" } }), null);
  assert.equal(routingProfileWith(profile, null), null, "clearing the only entry clears the profile");
  assert.deepEqual(routingProfileWith({ other: 1, version: 1, fallback: policy }, null), { other: 1, version: 1, fallback: null });
});

test("a provider failure with a healthy, compatible, same-privacy target applies", () => {
  const decision = evaluateFallback(policy, primary, candidate(), failed, report());
  assert.equal(decision.apply, true);
  assert.equal(decision.reason, "Anthropic failed: Synthetic overload. Continued with OpenAI · GPT-4.1 mini.");
});

test("a user stop never falls back", () => {
  const decision = evaluateFallback(policy, primary, candidate(), { status: "cancelled", code: null, message: "Stopped" }, report());
  assert.equal(decision.apply, false);
  assert.match(decision.reason, /stopped by you/);
});

test("a missing connection, missing model or the failed target itself are refused by name", () => {
  assert.match(evaluateFallback(policy, primary, null, failed, null).reason, /"openai" is not configured on this device/);
  assert.match(evaluateFallback(policy, primary, candidate({ model: null }), failed, null).reason, /OpenAI has no reviewed model "gpt"/);
  const same = evaluateFallback(
    { provider: "anthropic", model: "claude", allowPrivacyChange: false },
    primary,
    candidate({ provider: { id: "anthropic", label: "Anthropic", privacy: "direct_provider" }, model: { id: "claude", name: "Claude" } }),
    failed,
    report(),
  );
  assert.match(same.reason, /the connection and model that failed/);
});

test("a privacy-class change is refused unless the policy allows it, and the allowance is recorded in the reason", () => {
  const relay = candidate({ provider: { id: "openai", label: "OpenAI", privacy: "quixi_relay" } });
  const refused = evaluateFallback(policy, primary, relay, failed, report());
  assert.equal(refused.apply, false);
  assert.equal(
    refused.reason,
    "Anthropic failed: Synthetic overload. Continuing with OpenAI · GPT-4.1 mini would change the privacy class from Direct provider to Quixi relay, which this conversation's fallback does not allow.",
  );
  const allowed = evaluateFallback({ ...policy, allowPrivacyChange: true }, primary, relay, failed, report());
  assert.equal(allowed.apply, true);
  assert.match(allowed.reason, /privacy class Direct provider → Quixi relay, allowed by this conversation/);
});

test("a target whose health blocks sending or whose report refuses the path is not used", () => {
  const blockedHealth = evaluateFallback(
    policy,
    primary,
    candidate({ health: { blocksSending: true, label: "Authentication expired", detail: "reconnect it in Providers" } }),
    failed,
    report(),
  );
  assert.equal(blockedHealth.apply, false);
  assert.match(blockedHealth.reason, /OpenAI · GPT-4.1 mini cannot send now: Authentication expired · reconnect it in Providers\./);
  const incompatible = evaluateFallback(
    policy,
    primary,
    candidate(),
    { status: "partial", code: "provider_error", message: "Stream error" },
    report({
      sendable: false,
      blocked: [{ partId: "p", kind: "Image", code: "images_unsupported", message: "x" }],
      constraints: [{ messageIndex: null, partId: null, code: "system_unsupported", message: "No system prompt." }],
    }),
  );
  assert.equal(incompatible.apply, false);
  assert.equal(incompatible.reason, "Anthropic partial: Stream error. OpenAI · GPT-4.1 mini cannot carry this path: Image (images_unsupported); No system prompt..");
});
