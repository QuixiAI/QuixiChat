import { AUDIO_MEDIA_TYPES, unknownCapabilities, type ModelCapabilities, type ModelDescription } from './types.ts';
/** Provider facts and the implemented request profile are deliberately separate. */
export interface ReviewedCatalog {
  providerId: 'openai' | 'anthropic';
  review: { profile: 'openai-chat-completions-v1' | 'anthropic-messages-2023-06-01'; reviewedAt: number; sources: readonly string[] };
  model: ModelDescription;
  adapterCapabilities: ModelCapabilities;
  limitations: readonly string[];
  additionalModels?: readonly { model: ModelDescription; adapterCapabilities: ModelCapabilities; limitations: readonly string[] }[];
}
const reviewedAt = Date.parse('2026-09-09T00:00:00Z');
const fileReviewedAt = Date.parse('2026-09-10T00:00:00Z');
/** Manual-thinking contract and continuation review for Haiku 4.5. */
const thinkingReviewedAt = Date.parse('2026-09-11T00:00:00Z');
const thinkingSource = 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking';
const thinkingOverviewSource = 'https://platform.claude.com/docs/en/build-with-claude/thinking';
const countTokensSource = 'https://platform.claude.com/docs/en/api/messages-count-tokens';
const openaiChatSource = 'https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create';
const openaiChatParameterSource = 'https://github.com/openai/openai-node/blob/master/src/resources/chat/completions/completions.ts';
const claudeMessagesSource = 'https://platform.claude.com/docs/en/api/messages/create';
/** Published per-million-token rates read on 2026-09-09. Anthropic's cache
 * write rate is the 5-minute rate; Quixi sends no cache_control, so writes
 * stay at zero. Estimates are not bills. */
const claudePricingSource = 'https://platform.claude.com/docs/en/about-claude/pricing';
const openaiPricingSource = 'https://developers.openai.com/api/docs/models/gpt-4.1-mini';
const audioSource = 'https://developers.openai.com/api/docs/models/gpt-audio-1.5';
const audioGuideSource = 'https://developers.openai.com/api/docs/guides/audio-chat-completions';
const openaiSource = 'https://developers.openai.com/api/docs/models/gpt-4.1-mini';
const claudeSource = 'https://platform.claude.com/docs/en/models/haiku-4-5/overview';
const base = (): ModelCapabilities => ({...unknownCapabilities,inputModalities:['text','image','file'],outputModalities:['text'],streaming:'supported',tools:'supported',images:'supported',files:'supported',fileMediaTypes:['application/pdf']});
function entry(providerId: ReviewedCatalog['providerId']): ReviewedCatalog {
  const anthropic = providerId === 'anthropic';
  const capabilities: ModelCapabilities = {...base(),contextWindow:anthropic?200_000:1_047_576,maxOutputTokens:anthropic?64_000:32_768,systemPromptMode:anthropic?'top_level':'developer',reasoning:anthropic?'supported':'unsupported',structuredOutput:anthropic?'unknown':'supported',parameters:anthropic?['maxOutputTokens','temperature','topP','stopSequences','thinkingBudgetTokens']:['maxOutputTokens','temperature','topP','stopSequences'],...(anthropic?{thinkingProfile:'anthropic-manual-haiku-4.5' as const}:{})};
  return {
    providerId,
    ...(!anthropic ? { additionalModels: [audioEntry()] } : {}),
    review:{profile:anthropic?'anthropic-messages-2023-06-01':'openai-chat-completions-v1',reviewedAt:anthropic?thinkingReviewedAt:fileReviewedAt,sources:anthropic?[claudeSource,claudeMessagesSource,claudePricingSource,'https://platform.claude.com/docs/en/build-with-claude/pdf-support',thinkingSource,thinkingOverviewSource,countTokensSource]:[openaiSource,openaiChatSource,openaiChatParameterSource,openaiPricingSource,'https://developers.openai.com/api/docs/guides/file-inputs',audioSource,audioGuideSource]},
    model:{id:anthropic?'claude-haiku-4-5-20251001':'gpt-4.1-mini-2025-04-14',name:anthropic?'Claude Haiku 4.5':'GPT-4.1 mini',protocol:anthropic?'anthropic':'openai-compatible',capabilities,pricing:anthropic?{currency:'USD',inputPerMillion:'1',outputPerMillion:'5',cachedInputPerMillion:'0.10',cacheWriteInputPerMillion:'1.25',sourceUrl:claudePricingSource,verifiedAt:reviewedAt}:{currency:'USD',inputPerMillion:'0.40',outputPerMillion:'1.60',cachedInputPerMillion:'0.10',cacheWriteInputPerMillion:null,sourceUrl:openaiPricingSource,verifiedAt:reviewedAt},provenance:{source:'operator_catalog',sourceUrl:anthropic?claudeSource:openaiSource,observedAt:fileReviewedAt},raw:null},
    adapterCapabilities:{...capabilities,inputModalities:['text','image','file'],images:'supported',files:'supported',fileMediaTypes:['application/pdf'],reasoning:anthropic?'supported':'unsupported',structuredOutput:'unsupported',webSearch:'unsupported',imageGeneration:'unsupported'},
    limitations:['This connection sends text, supported tool records, PNG/JPEG/GIF/WebP images and PDF files in user messages. Images and files share a 2.5 MiB raw request limit; encoded JSON remains limited to 4 MiB. PDF parsing, page limits and encryption acceptance are enforced by the provider.',anthropic?'Manual thinking can be enabled per request for this Haiku 4.5 snapshot with a budget of at least 1,024 tokens below the output limit (reviewed 2026-09-11); temperature is refused and top-p must be 0.95–1 while it is enabled. Complete signed and redacted thinking blocks this model produced are sent back unchanged from their verified receipts; Anthropic keeps only the latest turn\'s blocks for Haiku 4.5 and strips older ones itself. The shared chat does not invoke tools.':'The shared chat does not invoke tools or continue provider reasoning.',anthropic?'Prompt token counts come from Anthropic\'s count endpoint when you ask for them. Estimated prices apply the provider\'s published per-token rates as reviewed on 2026-09-09 to reported usage; they are not bills, and reported usage is what the provider states. Model access still depends on the account.':'Quixi does not implement token counting for this Chat Completions connection. Estimated prices apply the provider\'s published per-token rates as reviewed on 2026-09-09 to reported usage; they are not bills, and reported usage is what the provider states. Model access still depends on the account.',anthropic?'Temperature (0–1) and top-p are accepted for this Haiku 4.5 snapshot; Anthropic deprecates both for models released after Claude Opus 4.6. Quixi sends at most 4 stop sequences.':'Temperature (0–2), top-p and up to 4 stop sequences follow the Chat Completions reference, which recommends changing temperature or top-p, not both.'],
  };
}
function audioEntry(): NonNullable<ReviewedCatalog['additionalModels']>[number] {
  const capabilities: ModelCapabilities = {
    ...unknownCapabilities,
    inputModalities: ['text', 'audio'], outputModalities: ['text', 'audio'],
    audioMediaTypes: AUDIO_MEDIA_TYPES, contextWindow: 128_000, maxOutputTokens: 16_384,
    streaming: 'supported', tools: 'supported', reasoning: 'unsupported', structuredOutput: 'unsupported',
    images: 'unsupported', files: 'unsupported', webSearch: 'unsupported', imageGeneration: 'unsupported',
    systemPromptMode: 'system', parameters: ['maxOutputTokens', 'temperature', 'topP', 'stopSequences'],
  };
  return {
    model: { id: 'gpt-audio-1.5', name: 'GPT-Audio-1.5', protocol: 'openai-compatible', capabilities,
      pricing: null, provenance: { source: 'operator_catalog', sourceUrl: audioSource, observedAt: fileReviewedAt }, raw: null },
    adapterCapabilities: { ...capabilities, outputModalities: ['text'] },
    limitations: [
      'This connection sends WAV or MP3 audio in user messages and requests text replies. Audio output, recording and realtime sessions are not implemented.',
      'Audio shares the 2.5 MiB raw request limit with all attachment occurrences; encoded JSON remains limited to 4 MiB. At most 20 audio inputs are sent per request.',
      'Audio and text have different token rates. Quixi does not estimate a price for this model because its current pricing contract cannot represent that distinction.',
      'Model access depends on the account. The shared chat does not invoke tools or continue provider reasoning.',
    ],
  };
}
/** Dated reviewed snapshots, not an automatically trusted provider discovery result. */
export function initialProviderCatalogs(): readonly ReviewedCatalog[] { return [entry('openai'),entry('anthropic')]; }
export function adapterCatalog(catalog: ReviewedCatalog): ModelDescription[] {
  return [{ model: catalog.model, adapterCapabilities: catalog.adapterCapabilities }, ...(catalog.additionalModels ?? [])].map(({ model, adapterCapabilities }) => ({
    ...structuredClone(model), capabilities: structuredClone(adapterCapabilities),
    raw: { quixiCatalogScope: 'adapter_effective', quixiAdapterProfile: catalog.review.profile,
      providerInputModalities: [...model.capabilities.inputModalities], providerOutputModalities: [...model.capabilities.outputModalities],
      providerImages: model.capabilities.images, providerReasoning: model.capabilities.reasoning,
      providerStructuredOutput: model.capabilities.structuredOutput },
  }));
}
