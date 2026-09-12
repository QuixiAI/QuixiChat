import type { AccountHealth } from "@quixi/providers";

export const HEALTH_REFRESH = Object.freeze({
  initialDelayMs: 30_000,
  healthyIntervalMs: 300_000,
  retryBaseMs: 30_000,
  retryMaxMs: 300_000,
  tickMs: 1_000,
});

export interface HealthRefreshAttempt {
  readonly startedAt: number;
  readonly failures: number;
}

// Invalid timestamps cannot poison the scheduler with NaN or infinity. Keep
// finite future timestamps intact, including provider Retry-After deadlines.
function timestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function retryDelay(failures: number): number {
  const maximumExponent = Math.ceil(Math.log2(HEALTH_REFRESH.retryMaxMs / HEALTH_REFRESH.retryBaseMs));
  const exponent = failures === Infinity ? maximumExponent
    : Number.isFinite(failures) ? Math.min(maximumExponent, Math.max(0, Math.floor(failures) - 1)) : 0;
  return Math.min(HEALTH_REFRESH.retryMaxMs, HEALTH_REFRESH.retryBaseMs * 2 ** exponent);
}

/**
 * Pure wall-clock deadline policy. Callers compare now >= deadline, retain
 * attempt state for the active credential, and reset it after explicit changes.
 * A newer generation observation or attempt moves the deadline forward; an old
 * observation cannot cause an immediate retry after a recently started check.
 */
export function nextHealthRefreshAt(health: AccountHealth, attempt: HealthRefreshAttempt | null): number | null {
  // Repeated probes cannot repair credentials; wait for explicit user action.
  if (health.status === "authentication_expired") return null;
  const anchor = Math.max(timestamp(health.observedAt), timestamp(attempt?.startedAt ?? 0));
  const delay = health.evidence === "none" ? HEALTH_REFRESH.initialDelayMs
    : health.status === "healthy" ? HEALTH_REFRESH.healthyIntervalMs
      : health.status === "region_unavailable" ? HEALTH_REFRESH.retryMaxMs
        : retryDelay(attempt?.failures ?? 0);
  // Saturating addition also keeps extreme finite input timestamps finite.
  const deadline = Math.min(Number.MAX_VALUE, anchor + delay);
  return Math.max(deadline, timestamp(health.retryAt ?? 0));
}
