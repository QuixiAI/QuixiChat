import test from "node:test";
import assert from "node:assert/strict";
import type { AccountHealth } from "@quixi/providers";
import {
  describeConnectionHealth,
  observedHealth,
} from "../../src/features/providers/health.ts";

const at = 1_000_000;
const health = (change: Partial<AccountHealth>): AccountHealth => ({
  status: "healthy",
  observedAt: at,
  retryAt: null,
  reason: null,
  evidence: "generation",
  ...change,
});

test("a fresh adapter has no observed health; probes and responses do", () => {
  assert.equal(observedHealth(health({ status: "unknown", evidence: "none" })), null);
  assert.equal(observedHealth(null), null);
  assert.equal(observedHealth(health({}))?.status, "healthy");
});

test("every health state maps to a label, its evidence and an availability decision", () => {
  const view = (change: Partial<AccountHealth>, now = at) =>
    describeConnectionHealth(health(change), now, true);
  assert.deepEqual(view({}), {
    status: "healthy",
    label: "Healthy",
    detail: "from the last response",
    blocksSending: false,
    retryAt: null,
  });
  const limited = view({ status: "rate_limited", retryAt: at + 4_500, reason: "Too many requests" });
  assert.equal(limited.label, "Rate limited");
  assert.equal(limited.detail, "retry in 5 s · Too many requests · from the last response");
  assert.equal(limited.blocksSending, true);
  assert.equal(limited.retryAt, at + 4_500);
  const passed = view({ status: "rate_limited", retryAt: at + 4_500 }, at + 5_000);
  assert.equal(passed.blocksSending, false);
  assert.equal(passed.detail, "the retry time has passed · from the last response");
  const unknownRetry = view({ status: "rate_limited", evidence: "models_probe" });
  assert.equal(unknownRetry.blocksSending, false);
  const expired = view({ status: "authentication_expired", reason: "Invalid key" });
  assert.equal(expired.blocksSending, true);
  assert.equal(expired.detail, "the provider rejected the credential; reconnect it in Providers · Invalid key · from the last response");
  assert.equal(view({ status: "provider_degraded", reason: "502" }).blocksSending, false);
  assert.equal(view({ status: "region_unavailable" }).label, "Region unavailable");
  assert.equal(view({ status: "unknown", evidence: "transport" }).detail, "the last request did not establish provider status · from the last transport attempt");
});

test("the device's offline signal overrides any provider health and a missing one is not checked", () => {
  const offline = describeConnectionHealth(health({}), at, false);
  assert.equal(offline.status, "offline");
  assert.equal(offline.blocksSending, true);
  const none = describeConnectionHealth(null, at, true);
  assert.equal(none.status, "not_checked");
  assert.equal(none.blocksSending, false);
});
