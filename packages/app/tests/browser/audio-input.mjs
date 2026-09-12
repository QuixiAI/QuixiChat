import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const title = 'Audio notebook';
const modelId = 'gpt-audio-1.5';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
// Five valid MPEG-1 Layer III frames of synthetic mono silence, generated once
// with libmp3lame (32 kb/s, 44.1 kHz). No encoder is needed to run the proof.
const mp3 = Buffer.from('//sQxAADwAABpAAAACAAADSAAAAETEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xLEKYPAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDEU4PAAAGkAAAAIAAANIAAAARVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EsR9A8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EMSnA8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV', 'base64');
function wav(frequency = 440) {
  const sampleRate = 8000, samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1024 * Math.sin(2 * Math.PI * frequency * i / sampleRate)), 44 + i * 2);
  return bytes;
}
const originals = [
  { filename: 'original-synthetic.wav', mimeType: 'audio/wav', format: 'wav', bytes: wav() },
  { filename: 'original-synthetic.mp3', mimeType: 'audio/mpeg', format: 'mp3', bytes: mp3 },
];
async function selectModel(page, id) {
  const select = page.getByLabel('Model', { exact: true });
  if (await select.count()) await select.selectOption(id);
  else await page.getByRole('group', { name: 'Model choices', exact: true }).locator(`input[type="radio"][value="${id}"]`).check();
}
async function audioModel(page) {
  if (!(await page.getByLabel('Provider', { exact: true }).isVisible())) await page.getByText('Conversation settings', { exact: true }).click();
  await page.getByLabel('Provider', { exact: true }).selectOption('openai');
  await selectModel(page, modelId);
}
function assertAudio(body) {
  expect(body.model).toBe(modelId);
  expect(body.modalities).toEqual(['text']);
  expect(body.audio).toBeUndefined();
  const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
  expect(blocks.filter(block => block.type === 'input_audio')).toEqual(originals.map(file => ({ type: 'input_audio', input_audio: { data: file.bytes.toString('base64'), format: file.format } })));
  expect(blocks.filter(block => ['file', 'document', 'image_url'].includes(block.type))).toEqual([]);
  expect(JSON.stringify(body)).not.toContain('data:audio/');
}
async function regenerate(page, requests) {
  const review = page.getByRole('checkbox', { name: /I reviewed this switch/ });
  if (await review.count()) await review.check();
  const before = requests.length;
  await page.getByRole('button', { name: /^Generate another response — / }).last().click();
  await expect.poll(() => requests.length).toBe(before + 1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  assertAudio(requests.at(-1).body);
}

export async function exerciseAudioInput({ page, records, send, requests, countRequests, name, connect, temporary }) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  if (!(await page.getByLabel('Title', { exact: true }).isVisible())) await page.getByText('Conversation settings', { exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await audioModel(page);
  const pick = async file => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach files', exact: true }).click();
    await (await chooser).setFiles([file]);
  };
  const attached = page.getByRole('list', { name: 'Attached files', exact: true });
  const removed = wav(880);
  await pick({ name: 'removed-synthetic.wav', mimeType: 'audio/wav', buffer: removed });
  await expect(attached).toContainText('removed-synthetic.wav');
  for (const refused of [
    { name: 'unsupported.ogg', mimeType: 'audio/ogg', buffer: Buffer.from('OggS synthetic unsupported container') },
    { name: 'mislabeled.wav', mimeType: 'audio/wav', buffer: Buffer.from('synthetic bytes without RIFF/WAVE') },
    { name: 'mislabeled.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('synthetic bytes without MPEG or ID3') },
    { name: 'oversized.wav', mimeType: 'audio/wav', buffer: Buffer.concat([originals[0].bytes, Buffer.alloc(2_621_441 - originals[0].bytes.length)]) },
  ]) {
    const before = { requests: requests.length, counts: countRequests.length, messages: (await records(page, 'messages')).items.length };
    await pick(refused);
    await expect(page.getByRole('alert')).toContainText(refused.name);
    await expect(attached).not.toContainText(refused.name);
    expect(requests.length).toBe(before.requests); expect(countRequests.length).toBe(before.counts);
    expect((await records(page, 'messages')).items.length).toBe(before.messages);
  }
  await page.getByRole('button', { name: 'Remove removed-synthetic.wav', exact: true }).click();
  await expect(attached).toHaveCount(0);
  await pick({ name: originals[0].filename, mimeType: originals[0].mimeType, buffer: originals[0].bytes });
  // The chooser closes before asynchronous staging and handle release finish.
  // Wait for the visible idle state before starting a separate drop operation.
  await expect(attached).toContainText(originals[0].filename);
  await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toBeEnabled();
  const transfer = await page.evaluateHandle(({ filename, mimeType, base64 }) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], filename, { type: mimeType }));
    return data;
  }, { filename: originals[1].filename, mimeType: originals[1].mimeType, base64: originals[1].bytes.toString('base64') });
  await page.locator('form.composer').dispatchEvent('drop', { dataTransfer: transfer }); await transfer.dispose();
  for (const file of originals) await expect(attached).toContainText(file.filename);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await attached.locator('audio, iframe, object, embed, img').count()).toBe(0);
  await attached.screenshot({ path: `test-results/audio-input-${name}-staged.png` });
  const beforeSend = requests.length;
  await send(page, 'Describe these two original synthetic audio clips in text.');
  await expect.poll(() => requests.length).toBe(beforeSend + 1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  assertAudio(requests.at(-1).body);
  const state = (await records(page, 'threadStates')).items.find(value => value.title === title);
  const message = (await records(page, 'messages')).items.find(value => value.threadId === state.threadId && value.role === 'user');
  const parts = (await page.evaluate(id => window.appAcceptance.parts(id), message.id)).items;
  expect(parts.map(part => part.kind)).toEqual(['Text', 'Audio', 'Audio']);
  const allAttachments = (await records(page, 'attachments')).items;
  const attachments = parts.slice(1).map(part => allAttachments.find(value => value.id === part.data.attachmentId));
  for (const [index, file] of originals.entries()) {
    expect(attachments[index]).toMatchObject({ filename: file.filename, mimeType: file.mimeType, sizeBytes: file.bytes.length, blobSha256: digest(file.bytes), availability: 'available' });
    expect(await page.evaluate(sha => window.appAcceptance.attachmentFingerprint(sha), digest(file.bytes))).toEqual({ sha256: digest(file.bytes), byteLength: file.bytes.length });
  }
  expect(allAttachments.some(value => value.blobSha256 === digest(removed))).toBe(false);
  await regenerate(page, requests);

  const beforeRefusal = { requests: requests.length, counts: countRequests.length, messages: (await records(page, 'messages')).items.length, generations: (await records(page, 'generations')).items.length };
  await page.getByLabel('Message', { exact: true }).fill('Refuse this route without silently dropping either audio clip.');
  for (const provider of ['openai', 'anthropic']) {
    await page.getByLabel('Provider', { exact: true }).selectOption(provider);
    if (provider === 'openai') await selectModel(page, 'gpt-4.1-mini-2025-04-14');
    const report = page.getByRole('region', { name: 'Compatibility report', exact: true });
    await expect(report).toContainText('Blocked Audio:');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    expect(requests.length).toBe(beforeRefusal.requests); expect(countRequests.length).toBe(beforeRefusal.counts);
    expect((await records(page, 'messages')).items.length).toBe(beforeRefusal.messages);
    expect((await records(page, 'generations')).items.length).toBe(beforeRefusal.generations);
    expect((await page.evaluate(id => window.appAcceptance.parts(id), message.id)).items).toEqual(parts);
  }
  await page.getByLabel('Message', { exact: true }).fill('');
  await audioModel(page);
  await regenerate(page, requests);

  await page.getByRole('button', { name: 'Export history', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare Quixi archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save prepared export', exact: true })).toBeVisible({ timeout: 30000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save prepared export', exact: true }).click();
  const exported = await readFile(await (await downloading).path());
  const path = resolve(temporary, `audio-input-${name}.tar`); await writeFile(path, exported);
  for (const file of originals) expect(execFileSync('tar', ['-xOf', path, `blobs/${digest(file.bytes)}`], { maxBuffer: 3 * 1024 * 1024 })).toEqual(file.bytes);
  await page.getByRole('button', { name: 'I checked the download — clear temporary copy', exact: true }).click();
  const restored = await page.context().newPage();
  try {
    await restored.goto('http://127.0.0.1:4197/composer-files-restore.html');
    await restored.getByRole('button', { name: 'Export history', exact: true }).click();
    const chooser = restored.waitForEvent('filechooser');
    await restored.getByRole('button', { name: 'Choose portable archive', exact: true }).click();
    await (await chooser).setFiles({ name: 'synthetic-audio.tar', mimeType: 'application/x-tar', buffer: exported });
    await expect(restored.getByRole('button', { name: 'Prepare replacement review', exact: true })).toBeVisible({ timeout: 30000 });
    await restored.getByRole('button', { name: 'Prepare replacement review', exact: true }).click();
    await expect(restored.getByRole('button', { name: 'I reviewed this candidate — replace active archive', exact: true })).toBeVisible();
    await restored.getByRole('button', { name: 'I reviewed this candidate — replace active archive', exact: true }).click();
    await expect(restored.getByRole('button', { name: 'Open restored archive', exact: true })).toBeVisible({ timeout: 30000 });
    await restored.getByRole('button', { name: 'Open restored archive', exact: true }).click();
    await restored.getByRole('button', { name: title, exact: true }).click();
    await expect(restored.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect((await restored.evaluate(id => window.composerRestoreProof.parts(id), message.id)).items).toEqual(parts);
    for (const attachment of attachments) {
      expect(await restored.evaluate(id => window.composerRestoreProof.entity('attachments', id), attachment.id)).toEqual(attachment);
      expect(await restored.evaluate(sha => window.composerRestoreProof.fingerprint(sha), attachment.blobSha256)).toEqual({ sha256: attachment.blobSha256, byteLength: attachment.sizeBytes });
    }
    await connect(restored, 'OpenAI');
    await audioModel(restored);
    await regenerate(restored, requests);
    await restored.screenshot({ path: `test-results/audio-input-${name}-restored.png`, fullPage: true });
  } finally {
    await restored.evaluate(() => window.composerRestoreProof?.close()).catch(() => {});
    await restored.close();
  }
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  return { title, threadId: state.threadId, messageId: message.id, parts, attachments, files: originals.map(file => ({ filename: file.filename, format: file.format, sha256: digest(file.bytes), byteLength: file.bytes.length })), archiveSha256: digest(exported), restoredRegeneration: true, unsupportedModels: ['gpt-4.1-mini-2025-04-14', 'claude-haiku-4-5-20251001'], refusedFileCount: 4, textOutputOnly: true };
}

export async function verifyAudioInputRestart({ page, records, requests, countRequests, evidence, name }) {
  const before = { requests: requests.length, counts: countRequests.length };
  await page.getByRole('button', { name: evidence.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: evidence.title, exact: true })).toBeVisible();
  expect((await page.evaluate(id => window.appAcceptance.parts(id), evidence.messageId)).items).toEqual(evidence.parts);
  for (const attachment of evidence.attachments) {
    expect((await records(page, 'attachments')).items.find(value => value.id === attachment.id)).toEqual(attachment);
    expect(await page.evaluate(sha => window.appAcceptance.attachmentFingerprint(sha), attachment.blobSha256)).toEqual({ sha256: attachment.blobSha256, byteLength: attachment.sizeBytes });
  }
  expect(requests.length).toBe(before.requests); expect(countRequests.length).toBe(before.counts);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/audio-input-${name}-restart.png`, fullPage: true });
}
