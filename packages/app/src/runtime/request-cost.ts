import type { RoutingRequirements } from "@quixi/core/contracts";
import type { Pricing } from "@quixi/providers";

export interface RequestCostInput {
  requirements: RoutingRequirements;
  pricing: Pricing | null;
  contextWindow: number | null;
  maxOutputTokens: number;
  /** Only pass a count verified by the caller for this exact model and request. */
  countedInputTokens?: number | null;
}

export interface RequestCostAssessment {
  allowed: boolean;
  reason: string;
  inputAmount: string | null;
  totalAmount: string | null;
  basis: "counted" | "context_bound" | "unavailable";
}

const NANO = 1_000_000_000n;
const MILLION = 1_000_000n;

function decimalNanos(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,9}(\.\d{1,9})?$/.test(value))
    return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * NANO + BigInt(fraction.padEnd(9, "0"));
}

function dollars(nanos: bigint): string {
  const fraction = (nanos % NANO).toString().padStart(9, "0").replace(/0+$/, "");
  return `${nanos / NANO}${fraction ? `.${fraction}` : ""}`;
}

function upward(numerator: bigint): bigint {
  return (numerator + MILLION - 1n) / MILLION;
}

/** Per-attempt estimate, not a billed-cost guarantee or a cumulative retry budget. */
export function assessRequestCost(input: RequestCostInput): RequestCostAssessment {
  const { requirements, pricing, contextWindow, maxOutputTokens, countedInputTokens } = input;
  const unavailable = (reason: string): RequestCostAssessment => ({
    allowed: false, reason, inputAmount: null, totalAmount: null, basis: "unavailable",
  });
  if (requirements.maxRequestCost === undefined && requirements.maxEstimatedRequestCost === undefined)
    return { ...unavailable("No request cost limit configured"), allowed: true };

  const inputCap = requirements.maxRequestCost === undefined ? null : decimalNanos(requirements.maxRequestCost);
  const totalCap = requirements.maxEstimatedRequestCost === undefined ? null : decimalNanos(requirements.maxEstimatedRequestCost);
  if ((requirements.maxRequestCost !== undefined && inputCap === null) ||
      (requirements.maxEstimatedRequestCost !== undefined && totalCap === null))
    return unavailable("Request cost limits must be nonnegative USD decimals with at most nine digits on each side of the decimal point");
  if (!pricing || pricing.currency !== "USD")
    return unavailable("Verified USD input and output pricing is required for a request cost limit");
  const inputRate = decimalNanos(pricing.inputPerMillion);
  const outputRate = decimalNanos(pricing.outputPerMillion);
  if (inputRate === null || outputRate === null)
    return unavailable("USD input and output prices must be nonnegative decimals with at most nine digits on each side of the decimal point");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
    return unavailable("A positive safe-integer output token limit is required for a request cost limit");
  if (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0))
    return unavailable("The declared context window is invalid for a request cost limit");

  const counted = countedInputTokens !== undefined && countedInputTokens !== null;
  if (counted && (!Number.isSafeInteger(countedInputTokens) || countedInputTokens < 0))
    return unavailable("The model-bound input token count is invalid for a request cost limit");
  if (counted && contextWindow !== null && countedInputTokens > contextWindow)
    return unavailable("The model-bound input token count exceeds the declared context window");
  if (!counted && contextWindow === null)
    return unavailable("A model-bound input token count or a declared context window is required for a request cost limit");

  const tokens = counted ? countedInputTokens : contextWindow!;
  const inputNumerator = BigInt(tokens) * inputRate;
  const inputNanos = upward(inputNumerator);
  const totalNanos = upward(inputNumerator + BigInt(maxOutputTokens) * outputRate);
  const inputAmount = dollars(inputNanos);
  const totalAmount = dollars(totalNanos);
  const basis = counted ? "counted" : "context_bound";
  const description = counted
    ? `Counted input estimate (${tokens} tokens)`
    : `Conservative context bound (${tokens} input tokens)`;
  const result = { inputAmount, totalAmount, basis } as const;
  if (inputCap !== null && inputNanos > inputCap)
    return { ...result, allowed: false, reason: `${description}: estimated input cost ${inputAmount} USD exceeds the ${requirements.maxRequestCost} USD input limit` };
  if (totalCap !== null && totalNanos > totalCap)
    return { ...result, allowed: false, reason: `${description}: estimated input plus maximum output cost ${totalAmount} USD exceeds the ${requirements.maxEstimatedRequestCost} USD per-attempt limit` };
  return { ...result, allowed: true, reason: `${description}: estimated input ${inputAmount} USD; input plus maximum output ${totalAmount} USD fits the configured per-attempt limits` };
}
