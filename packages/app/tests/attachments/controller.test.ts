import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { HostClient, StorageClient, HostFile, ByteChunk } from '@quixi/core/contracts';
import { createComposerAttachments } from '../../src/features/attachments/composer-attachments.ts';
import { COMPOSER_ATTACHMENT_LIMITS, audioMediaType } from '../../src/features/attachments/staging.ts';
const id = () => crypto.randomUUID();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const pdf = (length = 41) => { const bytes = new Uint8Array(length).fill(65); bytes.set(new TextEncoder().encode('%PDF-1.7\n')); return bytes; };
const image = (length = 41) => { const bytes = new Uint8Array(length); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); return bytes; };
type FixtureFile = HostFile & { bytes: Uint8Array };
const file = (bytes = pdf(), mediaType: string | null = 'application/pdf', name = 'synthetic.pdf'): FixtureFile => ({ id: id(), name, mediaType, byteLength: bytes.length, bytes });
function fixture(files: FixtureFile[], pause: 'picker' | 'read' | 'begin' | 'finish' | 'release' | 'write' | null = null, pauseFile = 0, chunkBytes = 16384) {
  const entered = gate(), released = gate();
  const opened: string[] = [], freed: string[] = [], cancelled: string[] = [], storageCancelled: string[] = [], sourceReleased: string[] = [], selections: string[][] = [];
  const sources = new Map<string, { file: FixtureFile; offset: number; sequence: number }>();
  const stages = new Map<string, { bytes: Uint8Array[]; finished: boolean; discarded: boolean }>();
  let once = false, stageNumber = 0;
  const hold = async (kind: typeof pause, fileId?: string) => {
    if (kind === pause && !once && (!fileId || fileId === files[pauseFile]?.id)) { once = true; entered.resolve(); await released.promise; }
  };
  const host = {
    async chooseFiles(_requestId: string, options: { mediaTypes: string[] }) { selections.push(options.mediaTypes); await hold('picker'); return files; },
    async adoptFiles() { await hold('picker'); return files; },
    async openFileTransfer(_requestId: string, fileId: string) { opened.push(fileId); const transferId = id(); sources.set(transferId, { file: files.find(file => file.id === fileId)!, offset: 0, sequence: 0 }); return { transferId, maxChunkBytes: 1048576, maxInFlight: 1 }; },
    async readChunk(transferId: string): Promise<ByteChunk> { const source = sources.get(transferId)!; await hold('read', source.file.id); const offset = source.offset, end = Math.min(source.file.bytes.length, offset + chunkBytes); source.offset = end; return { transferId, sequence: source.sequence++, offset, bytes: source.file.bytes.slice(offset, end), final: end === source.file.bytes.length }; },
    async acknowledgeChunk() {},
    async releaseTransfer(_requestId: string, transferId: string) { sourceReleased.push(transferId); await hold('release'); if (pause === 'read' && sources.get(transferId)?.file.id === files[pauseFile]?.id) released.resolve(); },
    async releaseFile(_requestId: string, fileId: string) { freed.push(fileId); },
    async cancel(requestId: string) { cancelled.push(requestId); return { requestId, outcome: 'cancelled', externalEffect: 'not_dispatched' }; },
  } as unknown as HostClient;
  const storage = {
    async request(_requestId: string, operation: string, args: any) {
      if (operation === 'beginBlobTransfer') { const transferId = 'stage-' + (++stageNumber); stages.set(transferId, { bytes: [], finished: false, discarded: false }); await hold('begin'); return { transferId, maxChunkBytes: 1048576, maxInFlight: 1 }; }
      const stage = stages.get(args.transferId)!;
      if (operation === 'discardBlobTransfer') { stage.discarded = true; if (pause === 'write') released.resolve(); return { discarded: true }; }
      if (operation === 'finishBlobTransfer') {
        const bytes = Buffer.concat(stage.bytes); assert.equal(bytes.length, args.expectedBytes); assert.equal(hash(bytes), args.expectedSha256);
        stage.finished = true; await hold('finish'); return { transferId: args.transferId, sha256: hash(bytes), byteLength: bytes.length, state: 'verified_staged' };
      }
      throw new Error('Unexpected storage operation');
    },
    async sendChunk(chunk: ByteChunk) {
      assert(chunk.bytes.length <= 65536, 'composer never sends a larger chunk even when worker admits 1 MiB');
      const stage = stages.get(chunk.transferId)!; stage.bytes.push(chunk.bytes.slice()); await hold('write');
      return { transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length };
    },
    async cancel(requestId: string) { storageCancelled.push(requestId); return { requestId, operationId: null, outcome: 'unknown_outcome' }; },
  } as unknown as StorageClient;
  return { controller: createComposerAttachments({ host, storage }), entered, released, opened, freed, cancelled, storageCancelled, sourceReleased, selections, stages };
}

test('selection derives supported types, preserves PDF bytes and image previews, and releases all handles', async () => {
  const files = [file(), file(image(), 'image/png', 'image.png')], f = fixture(files);
  await f.controller.choose(['application/pdf', 'image/png', 'application/msword']);
  assert.deepEqual(f.selections, [['image/png', 'application/pdf']]);
  assert.deepEqual(f.controller.getSnapshot().items.map(item => item.kind), ['File', 'Image']);
  assert.equal(f.controller.getSnapshot().items[0]!.previewUrl, null);
  assert(f.controller.getSnapshot().items[1]!.previewUrl?.startsWith('blob:'));
  assert.deepEqual(f.controller.staged()[0]!.bytes, files[0]!.bytes); assert.equal(f.controller.staged()[0]!.sha256, hash(files[0]!.bytes));
  assert.deepEqual(f.freed, files.map(file => file.id)); await f.controller.clear(); assert([...f.stages.values()].every(stage => stage.discarded));
});

test('legacy selection remains image-only and unsupported known files never open a transfer', async () => {
  const files = [file(), file(pdf(), 'application/msword', 'document.doc')], f = fixture(files);
  await f.controller.choose(); assert.deepEqual(f.opened, []); assert.equal(f.controller.staged().length, 0); assert.equal(f.freed.length, 2); assert(f.controller.getSnapshot().notice);
});

for (const action of ['clear', 'dispose', 'cancelPending'] as const) test(`${action} during a picker releases even late, unvisited handles and publishes no attachment`, async () => {
  const files = [file(), file(), file()], f = fixture(files, 'picker'); const work = f.controller.choose(['application/pdf']); await f.entered.promise;
  await f.controller[action](); assert(f.cancelled.length > 0); assert.deepEqual(f.opened, []);
  f.released.resolve(); await work;
  assert.deepEqual(f.freed, files.map(file => file.id)); assert.equal(f.controller.staged().length, 0); assert.equal(f.controller.getSnapshot().busy, false); assert.equal(f.controller.getSnapshot().notice, null);
});

for (const phase of ['begin', 'finish', 'release'] as const) test(`clear during ${phase} cleans a late stage receipt without resurrecting the draft`, async () => {
  const files = [file(), file()], f = fixture(files, phase), work = f.controller.choose(['application/pdf']); await f.entered.promise;
  await f.controller.clear(); assert(f.sourceReleased.length > 0, 'cancel actively releases the source while the boundary is pending');
  if (phase !== 'release') assert.equal(f.storageCancelled.length, 1);
  f.released.resolve(); await work;
  assert([...f.stages.values()].every(stage => stage.discarded)); assert.equal(f.controller.staged().length, 0); assert.deepEqual(f.freed, files.map(file => file.id)); assert.equal(f.controller.getSnapshot().notice, null);
});

test('cancel releases a blocked source read and preserves an earlier completed attachment', async () => {
  const files = [file(), file(), file()], f = fixture(files, 'read', 1), work = f.controller.choose(['application/pdf']); await f.entered.promise;
  assert.equal(f.controller.staged().length, 1); f.controller.cancelPending(); await work;
  assert.equal(f.controller.staged().length, 1); assert.equal(f.controller.staged()[0]!.filename, files[0]!.name); assert.equal(f.opened.length, 2); assert.equal(f.freed.length, 3); assert(f.sourceReleased.length >= 2);
  assert.equal(f.controller.getSnapshot().notice, null); await f.controller.dispose(); assert([...f.stages.values()].every(stage => stage.discarded));
});

test('a cancelled picker retains the single-operation memory bound until its cleanup completes', async () => {
  const f = fixture([file()], 'picker'), work = f.controller.choose(['application/pdf']); await f.entered.promise; f.controller.cancelPending();
  assert.equal(f.controller.getSnapshot().busy, true); await f.controller.choose(['application/pdf']); assert.equal(f.selections.length, 1);
  f.released.resolve(); await work; assert.equal(f.controller.getSnapshot().busy, false);
  await f.controller.choose(['application/pdf']); assert.equal(f.selections.length, 2); assert.equal(f.controller.staged().length, 1); await f.controller.clear();
});

test('mixed images and PDFs share the aggregate byte limit before the next file opens', async () => {
  const files = [file(image(1500000), 'image/png', 'image.png'), file(pdf(1500000))], f = fixture(files);
  await f.controller.choose(['image/png', 'application/pdf']); assert.equal(f.opened.length, 1); assert.equal(f.controller.staged().length, 1); assert.match(f.controller.getSnapshot().notice!, /2.5 MiB in total/); assert.equal(f.freed.length, 2); await f.controller.clear();
});

test('attachment count is bounded and every excess selected handle is released', async () => {
  const files = Array.from({ length: COMPOSER_ATTACHMENT_LIMITS.attachmentsPerMessage + 2 }, () => file()), f = fixture(files);
  await f.controller.adopt([], ['application/pdf']); assert.equal(f.opened.length, 0);
  await f.controller.choose(['application/pdf']); assert.equal(f.controller.staged().length, 20); assert.equal(f.opened.length, 20); assert.equal(f.freed.length, files.length); assert.match(f.controller.getSnapshot().notice!, /at most 20 attachments/); await f.controller.dispose();
});


test('cancel queues stage disposal during an acknowledged storage write and rejects its late receipt', async () => {
  const files = [file(), file()], f = fixture(files, 'write'), work = f.controller.choose(['application/pdf']);
  await f.entered.promise; f.controller.cancelPending(); await work;
  assert.equal(f.controller.staged().length, 0); assert([...f.stages.values()].every(stage => stage.discarded)); assert.equal(f.freed.length, 2); assert(f.sourceReleased.length > 0);
});

// Synthetic headers exercise admission and unchanged storage, not codec decoding.
const wav = (length = 48) => {
  const bytes = new Uint8Array(length);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, length - 8, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  return bytes;
};
const mp3 = (tagged = true, length = 427) => {
  const bytes = new Uint8Array(length);
  if (tagged) bytes.set([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  bytes.set([0xff, 0xfb, 0x90, 0x00], tagged ? 10 : 0);
  return bytes;
};
const audioTypes = ['audio/wav', 'audio/mpeg'];

test('WAV and both MP3 signatures survive split prefixes with canonical MIME, original bytes and metadata only', async () => {
  const files = [file(wav(), 'audio/x-wav', 'clip.wav'), file(mp3(), 'audio/mp3', 'tagged.mp3'), file(mp3(false), null, 'frames.mp3')];
  const f = fixture(files, null, 0, 2);
  await f.controller.choose([...audioTypes, 'audio/ogg']);
  assert.deepEqual(f.selections, [audioTypes]);
  assert.equal(f.controller.getSnapshot().notice, null);
  assert.deepEqual(f.controller.getSnapshot().items.map(item => [item.kind, item.mediaType, item.previewUrl]), [['Audio', 'audio/wav', null], ['Audio', 'audio/mpeg', null], ['Audio', 'audio/mpeg', null]]);
  for (const [index, staged] of f.controller.staged().entries()) {
    assert.deepEqual(staged.bytes, files[index]!.bytes);
    assert.equal(staged.sha256, hash(files[index]!.bytes));
    assert.deepEqual(Buffer.concat(f.stages.get(staged.transferId)!.bytes), Buffer.from(files[index]!.bytes));
  }
  assert.deepEqual(f.freed, files.map(item => item.id));
  assert.equal(f.sourceReleased.length, files.length);
  await f.controller.clear();
  assert([...f.stages.values()].every(stage => stage.discarded));
});

test('common WAV and MP3 MIME aliases retain only canonical provider media types', async () => {
  const aliases = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', ' Audio/WAV ', 'audio/x-wav; codecs=pcm', 'audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/x-mpeg', 'audio/mpeg3', 'audio/x-mpeg-3'];
  const files = aliases.map((alias, index) => file(index < 6 ? wav() : mp3(), alias, `clip-${index}`));
  const f = fixture(files);
  await f.controller.choose(audioTypes);
  assert.equal(f.controller.staged().length, aliases.length);
  assert(f.controller.staged().every(item => audioTypes.includes(item.mediaType)));
  assert.equal(f.controller.getSnapshot().notice, null);
  await f.controller.dispose();
});

test('claimed audio signatures, contradictory MIME and impossible header lengths are refused before staging', async () => {
  const largeRiff = wav(); new DataView(largeRiff.buffer).setUint32(4, 999999, true);
  const largeTag = mp3(); largeTag.set([0x7f, 0x7f, 0x7f, 0x7f], 6);
  const badFrame = mp3(false); badFrame[1] = 0xeb; // Reserved MPEG version.
  const badTag = mp3(); badTag[6] = 128; // ID3 size is synchsafe.
  const files = [file(pdf(), 'audio/wav'), file(wav(), 'audio/mpeg'), file(mp3(), 'audio/wav'), file(largeRiff, 'audio/wav'), file(largeTag, 'audio/mpeg'), file(badFrame, 'audio/mpeg'), file(badTag, 'audio/mpeg'), file(mp3(false).slice(0, 12), 'audio/mpeg')];
  const f = fixture(files, null, 0, 3);
  await f.controller.choose(audioTypes);
  assert.equal(f.controller.staged().length, 0);
  assert.equal(f.stages.size, 0);
  assert.equal(f.opened.length, files.length);
  assert.equal(f.sourceReleased.length, files.length);
  assert.deepEqual(f.freed, files.map(item => item.id));
  assert.match(f.controller.getSnapshot().notice!, /WAV or MP3/);
});

test('audio model gates and unsupported formats refuse before source transfer admission', async () => {
  const files = [file(wav(), 'audio/x-wav'), file(mp3(), 'audio/mpeg'), file(mp3(), 'audio/ogg'), file(mp3(), 'application/octet-stream')];
  const f = fixture(files);
  await f.controller.choose(['image/png', 'application/pdf']);
  assert.equal(f.opened.length, 0); assert.equal(f.stages.size, 0); assert.equal(f.freed.length, files.length);
  const audio = fixture(files.slice(2));
  await audio.controller.choose(audioTypes);
  assert.equal(audio.opened.length, 0); assert.equal(audio.freed.length, 2);
  const disabled = fixture(files);
  await disabled.controller.choose([]);
  assert.equal(disabled.selections.length, 0); assert.equal(disabled.opened.length, 0);
  assert.match(disabled.controller.getSnapshot().notice!, /does not accept/);
});

test('WAV, images and PDFs share one byte limit and reject unknown or mismatched source sizes', async () => {
  const invalid = file(wav(), 'audio/wav'); invalid.byteLength = null;
  const tooLarge = file(wav(), 'audio/wav'); tooLarge.byteLength = COMPOSER_ATTACHMENT_LIMITS.attachmentBytes + 1;
  const files = [invalid, tooLarge, file(wav(1000000), 'audio/wav'), file(image(1000000), 'image/png'), file(pdf(1000000))];
  const f = fixture(files);
  await f.controller.choose([...audioTypes, 'image/png', 'application/pdf']);
  assert.equal(f.opened.length, 2); assert.equal(f.controller.staged().length, 2);
  assert.match(f.controller.getSnapshot().notice!, /2.5 MiB in total/);
  assert.equal(f.freed.length, files.length); await f.controller.clear();
  for (const mismatch of [-1, 1]) {
    const selected = file(wav(), 'audio/wav'); selected.byteLength! += mismatch;
    const changed = fixture([selected]); await changed.controller.choose(audioTypes);
    assert.equal(changed.controller.staged().length, 0);
    assert([...changed.stages.values()].every(stage => stage.discarded));
    assert.equal(changed.freed.length, 1); assert.equal(changed.sourceReleased.length, 1);
  }
});

test('audio selections obey the shared attachment count and release every excess file handle', async () => {
  const files = Array.from({ length: 22 }, (_, index) => file(index % 2 ? mp3() : wav(), index % 2 ? 'audio/mpeg' : 'audio/wav'));
  const f = fixture(files);
  await f.controller.choose(audioTypes);
  assert.equal(f.controller.staged().length, 20); assert.equal(f.opened.length, 20); assert.equal(f.freed.length, 22);
  assert.match(f.controller.getSnapshot().notice!, /at most 20 attachments/);
  await f.controller.dispose(); assert([...f.stages.values()].every(stage => stage.discarded));
});

for (const phase of ['read', 'begin', 'write', 'finish', 'release'] as const) test(`audio cancellation during ${phase} releases reads and discards late stages`, async () => {
  const files = [file(wav(), 'audio/wav'), file(mp3(), 'audio/mpeg')], f = fixture(files, phase);
  const work = f.controller.choose(audioTypes); await f.entered.promise;
  f.controller.cancelPending(); f.released.resolve(); await work;
  assert.equal(f.controller.staged().length, 0);
  assert.equal(f.controller.getSnapshot().busy, false); assert.equal(f.controller.getSnapshot().notice, null);
  assert([...f.stages.values()].every(stage => stage.discarded));
  assert.deepEqual(f.freed, files.map(item => item.id)); assert(f.sourceReleased.length > 0);
});

test('MP3 frame admission rejects reserved version, layer, bitrate and sample-rate fields', () => {
  assert.equal(audioMediaType(mp3(false)), 'audio/mpeg');
  const freeFormat = mp3(false); freeFormat[2] = 0;
  assert.equal(audioMediaType(freeFormat), 'audio/mpeg');
  for (const [offset, value] of [[1, 0xeb], [1, 0xf9], [1, 0xfd], [2, 0xf0], [2, 0x9c], [3, 0x02]]) {
    const bytes = mp3(false); bytes[offset!] = value!;
    assert.equal(audioMediaType(bytes), null);
  }
});
