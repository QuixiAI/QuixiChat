import { createHash } from 'node:crypto';
import { canonicalJson } from '@quixi/core/contracts';
import type { ContentPart, ContextSnapshot, Generation, Message, SummarySourceDescriptor } from '@quixi/core/model';
export const id = () => crypto.randomUUID();
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function sourceFixture() {
  const threadId = id(), rootId = id();
  const context: ContextSnapshot = { id: id(), threadId, previousId: null, version: 1, systemPrompt: 'Current system', preferredRoute: null, recordedAt: 1 };
  const message = (messageId: string, parentId: string | null): Message => ({ id: messageId, threadId, parentId, role: 'user', createdAt: 1, recordedAt: 1, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true });
  const root = message(rootId, null), tail = message(id(), rootId);
  const part: ContentPart = { id: id(), messageId: rootId, order: 0, kind: 'Text', data: { text: 'Keep case-sensitive identifier Q-17 unresolved.' } };
  const source: SummarySourceDescriptor = { version: 1, threadId, context, throughMessageId: rootId, messages: [{ message: root, parts: [part], generation: null }], attachments: [] };
  const generation = (outputId: string): Generation => ({ purpose: 'context_summary', id: id(), threadId, parentMessageId: rootId, outputMessageId: outputId, contextSnapshotId: id(), provider: 'synthetic', providerAccountId: null, model: 'synthetic-model', parameters: {}, status: 'complete', createdAt: 1, recordedAt: 1, completedAt: 2, tokensIn: 12, tokensOut: 8, cachedTokens: null, estimatedCost: null, reportedCost: null, lastSequence: 1, rawResponseId: null, compatibility: [] });
  const info = () => ({ sourceFingerprint: digest(canonicalJson(source as never)), sourceMessageCount: source.messages.length, sourcePartCount: source.messages.reduce((count, item) => count + item.parts.length, 0) });
  return { threadId, root, tail, context, source, part, message, generation, info };
}
