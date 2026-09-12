export * from "./types.ts";
export { SSEDecoder } from "./sse.ts";
export { Normalizer } from "./normalize.ts";
import { createAdapter } from "./adapter.ts";
import type { ProviderOptions } from "./types.ts";
export const createOpenAICompatibleAdapter = (options: ProviderOptions) =>
  createAdapter("openai-compatible", options);
export const createAnthropicAdapter = (options: ProviderOptions) =>
  createAdapter("anthropic", options);
export { startGeneration } from "./generation.ts";
export type {
  GenerationRun,
  GenerationRunOptions,
  GenerationRunResult,
} from "./generation.ts";
export { initialProviderCatalogs, adapterCatalog } from './catalog.ts';
export type { ReviewedCatalog } from './catalog.ts';

export { openAIRegionalEvidence, openAIRelayRegionalEvidence, reviewedRegionalTransport, regionalLabel } from "./regional.ts";
export {
  bindReasoningEvidence,
  parseThinkingReceipt,
  reconstructThinkingReceipts,
  validateThinkingBlock,
  ReasoningEvidenceError,
  THINKING_RECEIPT_KIND,
} from "./reasoning.ts";
export type { ThinkingBlock, ThinkingReceipt, ReasoningBinding, ReasoningEntry } from "./reasoning.ts";
