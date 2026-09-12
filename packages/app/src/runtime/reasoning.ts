import type { Protocol, ProviderInput } from "@quixi/providers";
import type { Transformations } from "./portability.ts";
/** What one target receives of the branch's reasoning markers.
 *
 * Anthropic's thinking contract (read 2026-09-11) requires complete, unmodified
 * thinking blocks only inside a tool-use loop: the assistant turn whose tool
 * results follow. Outside that loop prior-turn thinking may be omitted, and a
 * block is readable only by the model that produced it. So a marker stays in
 * the request when its verified block belongs to the target model, or when
 * the loop requires it (where the mapper refuses anything unverifiable);
 * every other marker is omitted here and counted as a transformation. */
export interface ReasoningShape {
  input: ProviderInput;
  transformed: Pick<Transformations, "reasoningOmittedUnverified" | "reasoningOmittedForeign">;
  /** Assistant turns that held nothing but omitted markers and were dropped. */
  emptyAssistant: number;
}
export function shapeReasoningForTarget(
  input: ProviderInput,
  target: { protocol: Protocol; modelId: string },
): ReasoningShape {
  let unverified = 0, foreign = 0, emptyAssistant = 0, changed = false;
  const messages: ProviderInput["messages"][number][] = [];
  for (const [at, message] of input.messages.entries()) {
    if (message.role !== "assistant" || !message.parts.some((part) => part.kind === "ReasoningMetadata")) {
      messages.push(message);
      continue;
    }
    const next = input.messages[at + 1];
    const required = !!next && (next.role === "tool" || next.parts.some((part) => part.kind === "ToolResult"));
    if (required) {
      messages.push(message);
      continue;
    }
    const parts = message.parts.filter((part) => {
      if (part.kind !== "ReasoningMetadata") return true;
      const entry = input.reasoning?.[part.id];
      if (!entry) unverified++;
      else if (target.protocol !== "anthropic" || entry.modelId !== target.modelId) foreign++;
      else return true;
      return false;
    });
    if (parts.length === message.parts.length) {
      messages.push(message);
      continue;
    }
    changed = true;
    if (parts.length) messages.push({ ...message, parts });
    else emptyAssistant++;
  }
  return {
    input: changed ? { ...input, messages } : input,
    transformed: {
      ...(unverified ? { reasoningOmittedUnverified: unverified } : {}),
      ...(foreign ? { reasoningOmittedForeign: foreign } : {}),
    },
    emptyAssistant,
  };
}
/** Base transformations plus one target's reasoning omissions. */
export function withReasoningShape(base: Transformations, shape: ReasoningShape): Transformations {
  return { ...base, ...shape.transformed };
}
