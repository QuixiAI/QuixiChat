import type { AccountHealth } from "@quixi/providers";

/** What the composer shows for the selected connection and whether sending
 * is available. Health comes from the adapter's last probe or response; an
 * offline device overrides it. Nothing here guesses beyond that evidence. */
export interface ConnectionHealthView {
  status: AccountHealth["status"] | "offline" | "not_checked";
  label: string;
  detail: string | null;
  /** Sending is refused while true: the request would fail the same way. */
  blocksSending: boolean;
  /** When sending becomes available again by the clock, if known. */
  retryAt: number | null;
}

const LABELS: Record<AccountHealth["status"], string> = {
  healthy: "Healthy",
  rate_limited: "Rate limited",
  authentication_expired: "Authentication expired",
  provider_degraded: "Provider degraded",
  region_unavailable: "Region unavailable",
  offline: "Offline",
  unknown: "Unknown",
};
const EVIDENCE: Record<AccountHealth["evidence"], string | null> = {
  models_probe: "from a connection check",
  generation: "from the last response",
  transport: "from the last transport attempt",
  none: null,
};

/** Health the adapter has actually observed; a fresh adapter has none. */
export function observedHealth(
  health: AccountHealth | null | undefined,
): AccountHealth | null {
  return health && health.evidence !== "none" ? health : null;
}

export function describeConnectionHealth(
  health: AccountHealth | null,
  now: number,
  online: boolean,
): ConnectionHealthView {
  if (!online)
    return {
      status: "offline",
      label: "Offline",
      detail:
        "This device reports no network connection. Sending waits until it is back online.",
      blocksSending: true,
      retryAt: null,
    };
  if (!health)
    return {
      status: "not_checked",
      label: "Not checked",
      detail: "Send a message or check the connection in Providers to learn its status.",
      blocksSending: false,
      retryAt: null,
    };
  const parts: string[] = [];
  const evidence = EVIDENCE[health.evidence];
  if (health.reason) parts.push(health.reason);
  if (evidence) parts.push(evidence);
  let blocksSending = false,
    retryAt: number | null = null;
  if (health.status === "rate_limited") {
    if (health.retryAt !== null && health.retryAt > now) {
      blocksSending = true;
      retryAt = health.retryAt;
      parts.unshift(
        `retry in ${Math.ceil((health.retryAt - now) / 1000).toLocaleString()} s`,
      );
    } else parts.unshift("the retry time has passed");
  } else if (health.status === "authentication_expired") {
    blocksSending = true;
    parts.unshift(
      "the provider rejected the credential; reconnect it in Providers",
    );
  } else if (health.status === "unknown" && !health.reason)
    parts.unshift("the last request did not establish provider status");
  return {
    status: health.status,
    label: LABELS[health.status],
    detail: parts.length ? parts.join(" · ") : null,
    blocksSending,
    retryAt,
  };
}
