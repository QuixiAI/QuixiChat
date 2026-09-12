import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '@quixi/core/contracts';
import type { StorageClient } from '@quixi/core/contracts';
import { ATTACHMENT_EXCLUSION_MARKER, SUMMARY_INSTRUCTION } from '@quixi/core/model';
import type { Attachment, ContentPart } from '@quixi/core/model';
import { buildSummaryInput, collectSummarySource, readSummaryBytes, summaryHash } from '../../src/features/compaction/summary-source.ts';
import type { SummaryRequest } from '../../src/features/compaction/summary-source.ts';
import { digest, id, sourceFixture } from './fixtures.ts';
const forbidden = async () => { throw new Error('No blob read expected'); };
const noStorage = { request: forbidden } as unknown as StorageClient;
const noRequest = forbidden as SummaryRequest;
const check = () => {};

test('paged collection produces the exact canonical source descriptor and SHA-256 without reading blobs', async () => {
  const f = sourceFixture(), second = f.message(id(), f.root.id), generation = f.generation(second.id);
  delete generation.purpose; second.role = 'assistant'; second.generationId = generation.id;
  const part: ContentPart = { ...f.part, id: id(), messageId: second.id, data: { text: 'The identifier remains unresolved.' } };
  f.source.messages.push({ message: second, parts: [part], generation: { id: generation.id, status: generation.status } }); f.source.throughMessageId = second.id;
  const calls: string[] = [];
  const request = (async (op: string, args: any) => {
    calls.push(op);
    if (op === 'readConversationWindow') return { items: args.page.cursor ? [f.root] : [second], nextCursor: args.page.cursor ? null : 'older' };
    if (op === 'readMessageParts') return { items: args.messageId === f.root.id ? [f.part] : [part], nextCursor: null };
    if (op === 'readEntity' && args.collection === 'generations') return generation;
    assert.fail(`Unexpected read ${op}`);
  }) as SummaryRequest;
  const collected = await collectSummarySource(request, f.context, second.id);
  assert.deepEqual(collected, f.source);
  assert.equal(await summaryHash(canonicalJson(collected as never)), f.info().sourceFingerprint);
  assert(!calls.some(op => op.includes('Blob')));
});

test('repeated summary includes prior reviewed text and never loads covered prefix parts', async () => {
  const f = sourceFixture(), cutoff = id();
  f.root.parentId = cutoff;
  f.context.compaction = { version: 2, excludedPartIds: [], summary: { proposalId: id(), throughMessageId: cutoff, reviewedText: 'Previous reviewed correction.', reviewedTextSha256: digest('Previous reviewed correction.') } };
  const request = (async (op: string, args: any) => {
    if (op === 'readConversationWindow') return { items: [f.message(id(), null), f.message(cutoff, null), f.root], nextCursor: 'never-read' };
    if (op === 'readMessageParts') { assert.equal(args.messageId, f.root.id); return { items: [f.part], nextCursor: null }; }
    assert.fail(`Unexpected read ${op}`);
  }) as SummaryRequest;
  const source = await collectSummarySource(request, f.context, f.root.id);
  assert.deepEqual(source.messages.map(item => item.message.id), [f.root.id]);
  const built = await buildSummaryInput(source, noStorage, noRequest, 'synthetic', { maxOutputTokens: 2048 }, check);
  assert.equal(built.input.systemPrompt, SUMMARY_INSTRUCTION);
  assert.equal(built.input.parameters.maxOutputTokens, 1024);
  const text = built.input.messages[0]!.parts[0]!;
  assert.equal(text.kind, 'Text');
  assert.deepEqual(JSON.parse((text as Extract<ContentPart, { kind: 'Text' }>).data.text!), { kind: 'previous_reviewed_summary', proposalId: f.context.compaction.summary!.proposalId, throughMessageId: cutoff, text: 'Previous reviewed correction.' });
});

test('excluded image, file and audio occurrences become markers before any attachment byte read', async () => {
  for (const kind of ['Image', 'File', 'Audio'] as const) {
    const f = sourceFixture(), attachment: Attachment = { id: id(), availability: 'missing', filename: 'secret-name.png', mimeType: null, sizeBytes: null, blobSha256: null, rawObjectId: null };
    f.source.attachments = [attachment]; f.source.messages[0]!.parts = [{ ...f.part, kind, data: { attachmentId: attachment.id, description: 'private description' } }];
    f.context.compaction = { version: 1, excludedPartIds: [f.part.id] };
    const built = await buildSummaryInput(f.source, noStorage, noRequest, 'synthetic', { maxOutputTokens: 512 }, check);
    const text = JSON.stringify(built.input);
    assert(text.includes(ATTACHMENT_EXCLUSION_MARKER)); assert(!text.includes('secret-name')); assert(!text.includes('private description')); assert(!text.includes(attachment.id));
    assert.equal(built.imageBytes, 0); assert.equal(built.input.attachments, undefined);
  }
});

function blobFixture(bytes: Uint8Array, options: { offset?: number; stale?: boolean } = {}) {
  const calls: string[] = [], transferId = id(); let checks = 0;
  const request = (async (op: string) => { calls.push(op); assert.equal(op, 'readBlobTransfer'); return { transferId }; }) as SummaryRequest;
  const storage = { async request(_id: string, op: string) { calls.push(op); }, async readChunk() { calls.push('readChunk'); return { transferId, sequence: 0, offset: options.offset ?? 0, bytes, final: true }; }, async acknowledgeChunk() { calls.push('acknowledgeChunk'); } } as unknown as StorageClient;
  return { request, storage, calls, check() { if (options.stale && ++checks === 2) throw new Error('Stale source selection'); } };
}

test('image bytes are digest-verified, deduplicated and passed as images alongside quoted source labels', async () => {
  const f = sourceFixture(), bytes = new Uint8Array([137, 80, 78, 71]), blob = blobFixture(bytes);
  const attachment: Attachment = { id: id(), availability: 'available', filename: 'synthetic.png', mimeType: 'image/png', sizeBytes: bytes.length, blobSha256: digest(bytes), rawObjectId: null };
  f.source.attachments = [attachment]; f.root.partCount = 2;
  f.source.messages[0]!.parts = [0, 1].map(order => ({ id: id(), messageId: f.root.id, order, kind: 'Image', data: { attachmentId: attachment.id, description: null } }));
  const built = await buildSummaryInput(f.source, blob.storage, blob.request, 'synthetic', { maxOutputTokens: 512 }, check);
  assert.equal(built.imageBytes, bytes.length); assert.deepEqual(built.input.attachments?.[attachment.id]?.bytes, bytes);
  assert.equal(built.input.messages[0]!.parts.filter(part => part.kind === 'Image').length, 2);
  assert.equal(blob.calls.filter(call => call === 'readBlobTransfer').length, 1);
  assert.equal(blob.calls.at(-1), 'discardBlobTransfer');
});

test('byte bounds refuse before opening a transfer; corrupt, misordered and stale transfers are always discarded', async () => {
  await assert.rejects(readSummaryBytes(noStorage, noRequest, 'a'.repeat(64), 5, 4, check), /verified byte budget/);
  const bytes = new Uint8Array([1, 2, 3]);
  for (const options of [{}, { offset: 1 }, { stale: true }]) {
    const blob = blobFixture(bytes, options);
    await assert.rejects(readSummaryBytes(blob.storage, blob.request, 'a'.repeat(64), bytes.length, 10, blob.check), /digest verification|canonical length|Stale source/);
    assert.equal(blob.calls.at(-1), 'discardBlobTransfer');
  }
});

test('hidden reasoning and recognized transport records are omitted while unknown artifacts are refused', async () => {
  const f = sourceFixture(); f.root.partCount = 3;
  f.source.messages[0]!.parts.push({ id: id(), messageId: f.root.id, order: 1, kind: 'ReasoningMetadata', data: { redacted: true, summary: 'Never send this hidden text' } }, { id: id(), messageId: f.root.id, order: 2, kind: 'ProviderArtifact', data: { providerKind: 'quixi.provider.raw-stream-chunk', rawObjectId: id(), locator: '0' } });
  const built = await buildSummaryInput(f.source, noStorage, noRequest, 'synthetic', { maxOutputTokens: 512 }, check);
  assert.equal(built.omitted, 2); assert(!JSON.stringify(built.input).includes('Never send'));
  f.source.messages[0]!.parts[2] = { id: id(), messageId: f.root.id, order: 2, kind: 'ProviderArtifact', data: { providerKind: 'unknown.provider.shape', rawObjectId: id(), locator: '0' } };
  await assert.rejects(buildSummaryInput(f.source, noStorage, noRequest, 'synthetic', { maxOutputTokens: 512 }, check), /unknown provider artifact/);
});
