import test from "node:test";
import assert from "node:assert/strict";
import type { AccountHealth } from "@quixi/providers";
import { HEALTH_REFRESH, nextHealthRefreshAt } from "../../src/features/providers/health-refresh.ts";

const observedAt = 1_800_000_000_000;
function health(overrides: Partial<AccountHealth> = {}): AccountHealth {
  return { status: "unknown", observedAt, retryAt: null, reason: null, evidence: "none", ...overrides };
}

test("fresh accounts wait 30 seconds with an exact inclusive deadline", () => {
  const deadline = nextHealthRefreshAt(health(), null)!;
  assert.equal(deadline, observedAt + 30_000);
  assert.equal(observedAt + 29_999 >= deadline, false);
  assert.equal(observedAt + 30_000 >= deadline, true);
  assert.equal(nextHealthRefreshAt(health(), { startedAt: observedAt + 12_000, failures: 5 }), observedAt + 42_000);
  assert.equal(Object.isFrozen(HEALTH_REFRESH), true);
});

test("healthy observations defer checks five minutes from the latest observation or attempt", () => {
  const healthy = health({ status: "healthy", evidence: "models_probe" });
  assert.equal(nextHealthRefreshAt(healthy, null), observedAt + 300_000);
  assert.equal(nextHealthRefreshAt(healthy, { startedAt: observedAt + 45_000, failures: 0 }), observedAt + 345_000);
  assert.equal(nextHealthRefreshAt(healthy, { startedAt: observedAt - 45_000, failures: 10 }), observedAt + 300_000);
});

test("recent generation evidence postpones a previously due probe", () => {
  const attempt = { startedAt: observedAt, failures: 4 };
  const previous = health({ status: "offline", evidence: "transport" });
  assert.equal(nextHealthRefreshAt(previous, attempt), observedAt + 240_000);
  const latest = health({ status: "healthy", evidence: "generation", observedAt: observedAt + 239_999 });
  assert.equal(nextHealthRefreshAt(latest, attempt), observedAt + 539_999);
  assert.equal(nextHealthRefreshAt({ ...latest, status: "rate_limited", retryAt: observedAt + 900_000 }, attempt), observedAt + 900_000);
});

test("authentication expiry never schedules another automatic request", () => {
  for (const evidence of ["none", "models_probe", "generation", "transport"] as const) {
    assert.equal(nextHealthRefreshAt(health({ status: "authentication_expired", evidence, retryAt: observedAt + 30_000 }), { startedAt: observedAt, failures: 0 }), null);
  }
  assert.equal(nextHealthRefreshAt(health(), null), observedAt + 30_000);
});

test("observed transient failures back off from 30 seconds to the five minute cap", () => {
  for (const status of ["rate_limited", "provider_degraded", "offline", "unknown"] as const) {
    const failure = health({ status, evidence: "transport" });
    for (const [failures, delay] of [[0, 30_000], [1, 30_000], [2, 60_000], [3, 120_000], [4, 240_000], [5, 300_000], [100, 300_000]]) {
      assert.equal(nextHealthRefreshAt(failure, { startedAt: observedAt + 10_000, failures: failures! }), observedAt + 10_000 + delay!, `${status}, failure ${failures}`);
    }
    assert.equal(nextHealthRefreshAt(failure, null), observedAt + 30_000);
  }
});

test("region failures wait at least five minutes and still honor a later retry deadline", () => {
  const region = health({ status: "region_unavailable", evidence: "models_probe" });
  assert.equal(nextHealthRefreshAt(region, null), observedAt + 300_000);
  assert.equal(nextHealthRefreshAt(region, { startedAt: observedAt + 2_000, failures: 1 }), observedAt + 302_000);
  assert.equal(nextHealthRefreshAt({ ...region, retryAt: observedAt + 700_000 }, null), observedAt + 700_000);
});

test("Retry-After is a lower bound and never shortens the normal interval", () => {
  const failure = health({ status: "rate_limited", evidence: "generation" });
  for (const retryAt of [observedAt - 1, observedAt + 29_999, observedAt + 30_000]) {
    assert.equal(nextHealthRefreshAt({ ...failure, retryAt }, null), observedAt + 30_000);
  }
  assert.equal(nextHealthRefreshAt({ ...failure, retryAt: observedAt + 30_001 }, null), observedAt + 30_001);
  assert.equal(nextHealthRefreshAt({ ...failure, retryAt: Number.MAX_VALUE }, null), Number.MAX_VALUE);
});

test("invalid timestamp inputs cannot produce a nonfinite or negative deadline", () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1]) {
    assert.equal(nextHealthRefreshAt(health({ observedAt: invalid, retryAt: invalid }), { startedAt: invalid, failures: 0 }), 30_000);
    assert.equal(nextHealthRefreshAt(health({ retryAt: invalid }), null), observedAt + 30_000);
    assert.equal(nextHealthRefreshAt(health({ observedAt: invalid }), { startedAt: observedAt, failures: 0 }), observedAt + 30_000);
  }
  assert.equal(nextHealthRefreshAt(health({ observedAt: Number.MAX_VALUE }), null), Number.MAX_VALUE);
  assert.equal(nextHealthRefreshAt(health(), { startedAt: Number.MAX_VALUE, failures: 1 }), Number.MAX_VALUE);
});

test("extreme and fractional failure counts use bounded exponential arithmetic", () => {
  const failure = health({ status: "offline", evidence: "transport" });
  for (const failures of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.equal(nextHealthRefreshAt(failure, { startedAt: observedAt, failures }), observedAt + 300_000);
  }
  for (const failures of [NaN, -Infinity, -10, 0, 1.9]) {
    assert.equal(nextHealthRefreshAt(failure, { startedAt: observedAt, failures }), observedAt + 30_000);
  }
  assert.equal(nextHealthRefreshAt(failure, { startedAt: observedAt, failures: 2.9 }), observedAt + 60_000);
});

test("deadline calculation does not mutate health or attempt state", () => {
  const input = Object.freeze(health({ status: "offline", evidence: "transport" }));
  const attempt = Object.freeze({ startedAt: observedAt + 1, failures: 2 });
  assert.equal(nextHealthRefreshAt(input, attempt), observedAt + 60_001);
  assert.equal(input.observedAt, observedAt);
  assert.equal(attempt.failures, 2);
});
