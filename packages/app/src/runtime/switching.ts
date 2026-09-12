import type { CompatibilityReport } from "@quixi/providers";
import type { Cost } from "@quixi/core/model";
import { formatCostAmount } from "./usage.ts";

/** A prompt count that belongs to one draft, branch and target model. */
export interface TargetPromptCount {
  tokens: number;
  label: string;
}

/** The context and cost lines of a switch report, from the report and an
 * optional on-request count for the same target. Counting is never automatic
 * because it sends the branch to the target provider. */
export interface SwitchContext {
  /** Room the target leaves for input after the requested output, or null
   * when the catalog has no context window for it. */
  inputRoom: number | null;
  /** Tokens the count exceeds the room by; zero when it fits or is unknown. */
  overRoomBy: number;
  lines: string[];
}

const tokens = (value: number) => value.toLocaleString("en-US");

export function describeSwitchContext(
  report: CompatibilityReport,
  count: TargetPromptCount | null,
  costs: {
    input: (tokens: number) => Cost | null;
    output: (tokens: number) => Cost | null;
  },
  target: { label: string; countsTokens: boolean },
): SwitchContext {
  const { contextWindow, maxOutputTokens, inputRoom } = report.context;
  const lines: string[] = [];
  if (contextWindow === null || inputRoom === null)
    lines.push(
      `Context: the catalog records no context window for ${report.target.modelId}; requested output ${tokens(maxOutputTokens)} tokens.`,
    );
  else
    lines.push(
      `Context: target window ${tokens(contextWindow)} tokens · requested output ${tokens(maxOutputTokens)} · room for input ${tokens(inputRoom)} tokens.`,
    );
  let overRoomBy = 0;
  if (count) {
    if (inputRoom === null)
      lines.push(
        `Current prompt: ${tokens(count.tokens)} tokens counted by ${count.label}; the room is unknown, so the provider decides whether it fits.`,
      );
    else if (count.tokens > inputRoom) {
      overRoomBy = count.tokens - inputRoom;
      lines.push(
        `Current prompt: ${tokens(count.tokens)} tokens counted by ${count.label} · exceeds the room by ${tokens(overRoomBy)} tokens. Review attachment exclusions or generate and review a summary, then count again. You can also lower the output limit or choose a shorter branch.`,
      );
    } else
      lines.push(
        `Current prompt: ${tokens(count.tokens)} tokens counted by ${count.label} · fits with ${tokens(inputRoom - count.tokens)} tokens to spare.`,
      );
  } else if (target.countsTokens)
    lines.push(
      `Count prompt tokens to compare this draft and branch with the room; counting sends them to ${target.label}.`,
    );
  else
    lines.push(
      `Token counting is unavailable for ${target.label}${report.requestBytes !== null ? `; the encoded request is ${tokens(report.requestBytes)} bytes` : ""}.`,
    );
  const pricing = report.pricing;
  if (!pricing) lines.push("Cost: no reviewed price for this model.");
  else {
    const reviewed = new Date(pricing.verifiedAt).toISOString().slice(0, 10);
    const rates = `${formatCostAmount(pricing.inputPerMillion)} ${pricing.currency} per million input tokens and ${formatCostAmount(pricing.outputPerMillion)} ${pricing.currency} per million output tokens, reviewed ${reviewed}`;
    const input = count ? costs.input(count.tokens) : null;
    const output = costs.output(maxOutputTokens);
    if (input && output)
      lines.push(
        `Cost: ≈ ${formatCostAmount(input.amount)} ${input.currency} for the counted input plus up to ≈ ${formatCostAmount(output.amount)} ${output.currency} for ${tokens(maxOutputTokens)} output tokens, estimated from reviewed pricing (${rates}).`,
      );
    else lines.push(`Cost: reviewed rates are ${rates}; count the prompt for an input estimate.`);
  }
  return { inputRoom, overRoomBy, lines };
}
