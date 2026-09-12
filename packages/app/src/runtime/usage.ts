import type { ThreadUsage } from "@quixi/core/contracts";
import type { Generation } from "@quixi/core/model";

/** Show a reviewed-price amount without fabricated precision: trailing zeros
 * beyond two decimals are dropped, and nothing is rounded away. */
export function formatCostAmount(amount: string): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) return amount;
  const [whole, fraction = ""] = amount.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return `${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed}`;
}

const tokens = (value: number | null) =>
  value === null ? "unknown" : value.toLocaleString();

/** One attempt's usage line. Reported cost comes from the provider; an
 * estimate comes from the reviewed catalog price and is labelled as such. */
export function describeAttemptUsage(
  generation: Pick<
    Generation,
    "tokensIn" | "tokensOut" | "cachedTokens" | "estimatedCost" | "reportedCost"
  >,
): string {
  const cached =
    generation.cachedTokens !== null && generation.cachedTokens > 0
      ? ` (${generation.cachedTokens.toLocaleString()} cached)`
      : "";
  const cost = generation.reportedCost
    ? `${formatCostAmount(generation.reportedCost.amount)} ${generation.reportedCost.currency} reported by the provider`
    : generation.estimatedCost
      ? `≈ ${formatCostAmount(generation.estimatedCost.amount)} ${generation.estimatedCost.currency} estimated from reviewed pricing`
      : "unknown";
  return `Tokens in: ${tokens(generation.tokensIn)}${cached} · out: ${tokens(generation.tokensOut)} · Cost: ${cost}`;
}

/** Whole-conversation totals, aggregated by the storage worker over every
 * recorded attempt in the conversation, including deleted branches. */
export function describeThreadUsage(usage: ThreadUsage): string {
  if (usage.attempts === 0) return "No attempts yet.";
  const cached =
    usage.cachedTokens !== null && usage.cachedTokens > 0
      ? ` (${usage.cachedTokens.toLocaleString()} cached)`
      : "";
  const estimate = usage.estimatedCost
    ? `estimated ≈ ${formatCostAmount(usage.estimatedCost.amount)} ${usage.estimatedCost.currency} across ${usage.estimatedCost.attempts.toLocaleString()} priced ${usage.estimatedCost.attempts === 1 ? "attempt" : "attempts"}${usage.unpricedAttempts ? `, ${usage.unpricedAttempts.toLocaleString()} without a price` : ""}`
    : "no price estimate";
  const total = `${usage.attempts.toLocaleString()} ${usage.attempts === 1 ? "attempt" : "attempts"} · tokens in ${tokens(usage.tokensIn)}${cached} · out ${tokens(usage.tokensOut)} · ${estimate}`;
  return usage.summary ? `${total} · Summary proposals (included above): ${describeThreadUsage(usage.summary)}` : total;
}
