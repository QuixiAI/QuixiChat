import test from 'node:test';
import assert from 'node:assert/strict';
import type { StorageClient, ThreadView } from '@quixi/core/contracts';
import type { Attachment, ContentPart, Message } from '@quixi/core/model';
import type { ProviderAdapter, ProviderInput } from '@quixi/providers';
import { LIMITS } from '@quixi/providers';
import type { AppServices, ConfiguredProvider, LibraryController, LibrarySnapshot } from '../../src/runtime/library.ts';
import { createChatController, type ComposerAttachment } from '../../src/workflows/chat.ts';

const id = () => crypto.randomUUID();
const pdf = new TextEncoder().encode('%PDF-1.7\nSynthetic document bytes.\n%%EOF');
function fixture(options: { missing?: boolean; mediaType?: string; size?: number; malformed?: boolean; excluded?: boolean; copies?: number } = {}) {
  const threadId = id(), attachmentId = id(), partId = id();
  const parent: Message = { id: id(), threadId, parentId: null, role: 'user', createdAt: 1, recordedAt: 1,
    generationId: null, editedFromMessageId: null, partCount: 1, sealed: true };
  const attachment: Attachment = { id: attachmentId, availability: options.missing ? 'missing' : 'available',
    filename: 'original.pdf', mimeType: options.mediaType ?? 'application/pdf', sizeBytes: options.size ?? pdf.length,
    blobSha256: 'a'.repeat(64), rawObjectId: null };
  const part: ContentPart = { id: partId, messageId: parent.id, order: 0, kind: 'File', data: { attachmentId, description: 'original.pdf' } };
  const thread = { thread: { id: threadId }, state: { revision: 1, routingProfile: null }, context: {
    id: id(), threadId, previousId: null, version: 1, recordedAt: 1, systemPrompt: null, preferredRoute: null,
    ...(options.excluded ? { compaction: { version: 1, excludedPartIds: [partId] } } : {}),
  } } as ThreadView;
  let state = { thread, leaf: parent.id, busy: false, pendingMutation: false } as LibrarySnapshot;
  const inputs: ProviderInput[] = [], reads: string[] = [], released: string[] = [];
  const storage = { async request(_requestId: string, operation: string, args: any) {
    reads.push(operation);
    if (operation === 'readThreadView') return thread;
    if (operation === 'readConversationWindow') return { items: [parent], nextCursor: null };
    if (operation === 'readMessageParts') return { items: Array.from({ length: options.copies ?? 1 }, (_, i) =>
      i ? { ...part, id: id(), data: { ...part.data, attachmentId: id() } } : part), nextCursor: null };
    if (operation === 'readEntity') return { ...attachment, id: args.id };
    if (operation === 'readBlobTransfer') return { transferId: id(), byteLength: attachment.sizeBytes };
    if (operation === 'discardBlobTransfer') { released.push(args.transferId); return { discarded: true }; }
    assert.fail(`Unexpected ${operation}`);
  }, async readChunk(transferId: string) {
    const bytes = options.size ? new Uint8Array(options.size) : pdf;
    return { transferId, sequence: options.malformed ? 7 : 0, offset: 0, bytes, final: true };
  }, async acknowledgeChunk() {} } as unknown as StorageClient;
  const adapter = {
    analyze(input: ProviderInput) { inputs.push(input); return { sendable: true }; },
    async countTokens(input: ProviderInput) { inputs.push(input); return { tokens: 9, source: 'provider', reason: null }; },
    prepare(input: ProviderInput) { inputs.push(input); throw new Error('Captured before commit.'); },
  } as unknown as ProviderAdapter;
  const provider: ConfiguredProvider = { id: 'synthetic', label: 'Synthetic', adapter, models: [] };
  const library = { getSnapshot: () => state, patch(change: Partial<LibrarySnapshot>) { state = { ...state, ...change }; },
    async commit() { assert.fail('No writes allowed by this read/preparation fixture.'); } } as unknown as LibraryController;
  return { controller: createChatController(library, { storage } as AppServices), provider, inputs, reads, released, parent, attachmentId, library };
}

test('file inspection, counting, send preparation and regeneration rehydrate the same original bytes and filename', async () => {
  for (const action of ['inspect', 'count', 'send', 'regenerate'] as const) {
    const f = fixture();
    if (action === 'inspect') await f.controller.inspectSwitch(f.provider, 'model');
    if (action === 'count') await f.controller.countPrompt('Continue.', f.provider, 'model');
    if (action === 'send') await f.controller.send('Continue.', f.provider, 'model');
    if (action === 'regenerate') await f.controller.regenerate(f.parent, f.provider, 'model');
    assert.equal(f.inputs.length, 1, action);
    const input = f.inputs[0]!;
    assert.equal(input.messages[0]!.parts[0]!.kind, 'File');
    assert.deepEqual(input.attachments?.[f.attachmentId], { mediaType: 'application/pdf', filename: 'original.pdf', bytes: pdf });
    assert.equal(f.released.length, 1);
  }
});

test('missing and unsupported historical files remain File parts without invented text or byte reads', async () => {
  for (const options of [{ missing: true }, { mediaType: 'application/zip' }, { size: LIMITS.fileBytes + 1 }]) {
    const f = fixture(options), inspection = await f.controller.inspectSwitch(f.provider, 'model');
    assert.equal(f.inputs[0]!.messages[0]!.parts[0]!.kind, 'File');
    assert.equal(f.inputs[0]!.attachments?.[f.attachmentId]?.bytes.length, 0);
    assert.equal(f.inputs[0]!.attachments?.[f.attachmentId]?.mediaType, options.mediaType ?? 'application/pdf');
    assert.equal(inspection!.transformed.unavailableImages, 0);
    assert(!f.reads.includes('readBlobTransfer'));
  }
});

test('explicitly excluded File reads no attachment metadata or bytes', async () => {
  const f = fixture({ excluded: true });
  const inspection = await f.controller.inspectSwitch(f.provider, 'model');
  assert.equal(inspection!.transformed.excludedAttachments, 1);
  assert.equal(f.inputs[0]!.messages[0]!.parts[0]!.kind, 'Text');
  assert(!f.reads.includes('readEntity'));
  assert(!f.reads.includes('readBlobTransfer'));
});

test('aggregate allocation bound refuses before opening a second oversized branch attachment', async () => {
  const f = fixture({ copies: 2, size: LIMITS.attachmentBytes });
  await assert.rejects(f.controller.inspectSwitch(f.provider, 'model'), /attachments exceed/);
  assert.equal(f.reads.filter(op => op === 'readBlobTransfer').length, 1);
  assert.equal(f.released.length, 1);
  assert.equal(f.inputs.length, 0);
});

test('malformed storage sequence releases its reader and refuses before provider preparation', async () => {
  const f = fixture({ malformed: true });
  await assert.rejects(f.controller.inspectSwitch(f.provider, 'model'), /sequence/);
  assert.equal(f.released.length, 1);
  assert.equal(f.inputs.length, 0);
});

test('draft PDF kind and filename reach counting and compatibility inspection without publication', async () => {
  const draft: ComposerAttachment = { kind: 'File', transferId: id(), sha256: 'b'.repeat(64), byteLength: pdf.length,
    mediaType: 'application/pdf', filename: 'draft.pdf', bytes: pdf };
  for (const action of ['inspect', 'count'] as const) {
    const f = fixture();
    if (action === 'inspect') await f.controller.inspectSwitch(f.provider, 'model', { maxOutputTokens: 1024 }, [draft]);
    else await f.controller.countPrompt('', f.provider, 'model', { maxOutputTokens: 1024 }, [draft]);
    const input = f.inputs[0]!, part = input.messages.at(-1)!.parts[0]!;
    assert.equal(part.kind, 'File');
    assert('attachmentId' in part.data);
    assert.deepEqual(input.attachments?.[part.data.attachmentId], { mediaType: 'application/pdf', bytes: pdf, filename: 'draft.pdf' });
  }
});
