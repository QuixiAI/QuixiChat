import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { keyboardActivate, observeProgress, verifyProgress } from './keyboard-focus.mjs';

const title = 'PDF notebook';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function pdf(label) {
  const stream = `BT /F1 12 Tf 30 70 Td (${label}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
function fileBlock(provider, bytes, filename) {
  return provider === 'anthropic'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') }, title: filename }
    : { type: 'file', file: { filename, file_data: `data:application/pdf;base64,${bytes.toString('base64')}` } };
}
function assertFile(body, provider, bytes, filename) {
  const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
  expect(blocks.filter(block => block.type === 'file' || block.type === 'document')).toEqual([fileBlock(provider, bytes, filename)]);
  expect(JSON.stringify(body)).not.toContain('Original synthetic PDF F-17');
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(4 * 1024 * 1024);
}
async function reviewSwitch(page) {
  const review = page.getByRole('checkbox', { name: /I reviewed this switch/ });
  if (await review.count()) await review.check();
}
async function regenerate(page, requests) {
  await reviewSwitch(page);
  const before = requests.length;
  await page.getByRole('button', { name: /^Generate another response — / }).last().click();
  await expect.poll(() => requests.length).toBe(before + 1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
}

export async function exerciseComposerFiles({ page, records, send, requests, countRequests, connect, temporary, name, seededPng }) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  if (!(await page.getByLabel('Title', { exact: true }).isVisible())) await page.getByText('Conversation settings', { exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByLabel('Provider', { exact: true }).selectOption('openai');
  const attach = page.getByRole('button', { name: 'Attach files', exact: true });
  const chosen = pdf('Removed synthetic PDF'), original = pdf('Original synthetic PDF F-17');
  const filename = 'original-synthetic.pdf', sha256 = digest(original);
  const pick = async file => { const chooser = page.waitForEvent('filechooser'); await attach.click(); await (await chooser).setFiles([file]); };
  await pick({ name: 'removed-synthetic.pdf', mimeType: 'application/pdf', buffer: chosen });
  const attached = page.getByRole('list', { name: 'Attached files', exact: true });
  await expect(attached).toContainText('removed-synthetic.pdf');
  await expect(attached).toContainText('PDF');
  expect(await attached.locator('iframe, object, embed, img').count()).toBe(0);
  for (const refused of [
    { name: 'unsupported.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('synthetic unsupported file') },
    { name: 'mislabeled.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic bytes without PDF signature') },
    { name: 'oversized.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([original, Buffer.alloc(2_621_441 - original.length)]) },
  ]) {
    const before = requests.length;
    await pick(refused);
    await expect(page.getByRole('alert')).toContainText(refused.name);
    await expect(attached).not.toContainText(refused.name);
    expect(requests.length).toBe(before);
  }
  const transfer = await page.evaluateHandle(({ base64, filename }) => {
    const value = new DataTransfer();
    value.items.add(new File([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], filename, { type: 'application/pdf' }));
    return value;
  }, { base64: original.toString('base64'), filename });
  await page.locator('form.composer').dispatchEvent('drop', { dataTransfer: transfer }); await transfer.dispose();
  await expect(attached).toContainText(filename);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove removed-synthetic.pdf', exact: true }).click();
  await expect(attached).not.toContainText('removed-synthetic.pdf');
  await attached.screenshot({ path: `test-results/composer-files-${name}-staged.png` });
  const beforeSend = requests.length;
  await send(page, 'Read the original synthetic PDF.');
  await expect.poll(() => requests.length).toBe(beforeSend + 1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  assertFile(requests.at(-1).body, 'openai', original, filename);
  const state = (await records(page, 'threadStates')).items.find(value => value.title === title);
  const message = (await records(page, 'messages')).items.find(value => value.threadId === state.threadId && value.role === 'user');
  const parts = (await page.evaluate(id => window.appAcceptance.parts(id), message.id)).items;
  expect(parts.map(part => part.kind)).toEqual(['Text', 'File']);
  const attachment = (await records(page, 'attachments')).items.find(value => value.id === parts[1].data.attachmentId);
  expect(attachment).toMatchObject({ filename, mimeType: 'application/pdf', sizeBytes: original.length, blobSha256: sha256, availability: 'available' });
  expect((await records(page, 'attachments')).items.some(value => value.blobSha256 === digest(chosen))).toBe(false);
  expect(await page.evaluate(sha => window.appAcceptance.attachmentFingerprint(sha), sha256)).toEqual({ sha256, byteLength: original.length });
  await regenerate(page, requests); assertFile(requests.at(-1).body, 'openai', original, filename);
  await pick({ name: 'eligibility-check.png', mimeType: 'image/png', buffer: Buffer.from(seededPng, 'base64') });
  await expect(page.getByRole('img', { name: 'eligibility-check.png', exact: true })).toBeVisible();
  const beforeRegional = { requests: requests.length, counts: countRequests.length, generations: (await records(page, 'generations')).items.length };
  await page.getByLabel('Provider', { exact: true }).selectOption('openai-us');
  await page.getByLabel('Message', { exact: true }).fill('A text/image-only regional route must refuse this PDF.');
  const regionalReport = page.getByRole('region', { name: 'Compatibility report', exact: true });
  await expect(regionalReport).toContainText('Blocked File:');
  await expect(regionalReport).not.toContainText('Blocked Image:');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toHaveCount(0);
  for (const allowed of [false, true]) {
    await page.getByRole('button', { name: 'Providers', exact: true }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'OpenAI · US', exact: true }) });
    await card.getByLabel('I confirmed regional image-processing eligibility', { exact: true }).setChecked(allowed);
    await expect(card.getByText(allowed ? 'Eligibility: user-confirmed for text and images.' : 'Eligibility: user-confirmed for text.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(regionalReport).toContainText('Blocked File:');
    if (allowed) await expect(regionalReport).not.toContainText('Blocked Image:');
    else await expect(regionalReport).toContainText('Blocked Image:');
    await expect(page.getByRole('img', { name: 'eligibility-check.png', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    expect(requests.length).toBe(beforeRegional.requests);
    expect(countRequests.length).toBe(beforeRegional.counts);
    expect((await records(page, 'generations')).items.length).toBe(beforeRegional.generations);
  }
  expect(requests.length).toBe(beforeRegional.requests);
  expect(countRequests.length).toBe(beforeRegional.counts);
  expect((await records(page, 'generations')).items.length).toBe(beforeRegional.generations);
  await page.getByRole('button', { name: 'Remove eligibility-check.png', exact: true }).click();
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await reviewSwitch(page);
  await page.getByLabel('Message', { exact: true }).fill('Read the same PDF from stored history.');
  const beforeCount = countRequests.length;
  await page.getByRole('button', { name: 'Count prompt tokens', exact: true }).click();
  await expect.poll(() => countRequests.length).toBe(beforeCount + 1);
  assertFile(countRequests.at(-1).body, 'anthropic', original, filename);
  await send(page, 'Read the same PDF from stored history.');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  assertFile(requests.at(-1).body, 'anthropic', original, filename);
  await regenerate(page, requests); assertFile(requests.at(-1).body, 'anthropic', original, filename);
  expect((await page.evaluate(id => window.appAcceptance.parts(id), message.id)).items).toEqual(parts);

  await page.getByRole('button', { name: 'Export history', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare Quixi archive', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save prepared export', exact: true })).toBeVisible({ timeout: 30000 });
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save prepared export', exact: true }).click();
  const exported = await readFile(await (await downloading).path());
  const path = resolve(temporary, `composer-files-${name}.tar`); await writeFile(path, exported);
  const archived = execFileSync('tar', ['-xOf', path, `blobs/${sha256}`], { maxBuffer: 3 * 1024 * 1024 });
  expect(archived).toEqual(original);
  await page.getByRole('button', { name: 'I checked the download — clear temporary copy', exact: true }).click();

  const restored = await page.context().newPage();
  const restoredPageErrors = [];
  restored.on('pageerror', error => { if (restoredPageErrors.length < 16) restoredPageErrors.push(String(error).slice(0, 512)); });
  try {
    await restored.goto('http://127.0.0.1:4197/composer-files-restore.html');
    await restored.getByRole('button', { name: 'Export history', exact: true }).click();
    const stageRestore = async () => {
      await observeProgress(restored, 'restore-phase');
      const chooser = restored.waitForEvent('filechooser');
      await keyboardActivate(restored.getByRole('button', { name: 'Choose portable archive', exact: true }));
      await (await chooser).setFiles({ name: 'synthetic-composer-files.tar', mimeType: 'application/x-tar', buffer: exported });
      await expect(restored.getByRole('button', { name: 'Prepare replacement review', exact: true })).toBeVisible({ timeout: 30000 });
      await expect(restored.getByRole('button', { name: 'Choose portable archive', exact: true })).toBeFocused();
      await verifyProgress(restored);
      await keyboardActivate(restored.getByRole('button', { name: 'Prepare replacement review', exact: true }));
      await expect(restored.getByRole('button', { name: 'Review again', exact: true })).toBeFocused();
    };
    await stageRestore();
    await keyboardActivate(restored.getByRole('button', { name: 'Release restore work', exact: true }));
    await expect(restored.getByRole('region', { name: 'Restore candidate review', exact: true })).toHaveCount(0);
    await expect(restored.getByRole('heading', { name: 'Restore a Quixi archive', exact: true })).toBeFocused();
    await stageRestore();
    await keyboardActivate(restored.getByRole('button', { name: 'I reviewed this candidate — replace active archive', exact: true }));
    await expect(restored.getByRole('button', { name: 'Open restored archive', exact: true })).toBeVisible({ timeout: 30000 });
    await expect(restored.getByRole('heading', { name: 'Restore a Quixi archive', exact: true })).toBeFocused();
    await keyboardActivate(restored.getByRole('button', { name: 'Open restored archive', exact: true }));
    await restored.getByRole('button', { name: title, exact: true }).click();
    await expect(restored.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(await restored.evaluate(id => window.composerRestoreProof.entity('attachments', id), attachment.id)).toEqual(attachment);
    expect((await restored.evaluate(id => window.composerRestoreProof.parts(id), message.id)).items).toEqual(parts);
    expect(await restored.evaluate(sha => window.composerRestoreProof.fingerprint(sha), sha256)).toEqual({ sha256, byteLength: original.length });
    await connect(restored, 'Anthropic');
    await restored.getByLabel('Provider', { exact: true }).selectOption('anthropic');
    await regenerate(restored, requests);
    assertFile(requests.at(-1).body, 'anthropic', original, filename);
    await restored.evaluate(() => window.composerRestoreProof.close());
  } catch (error) {
    const diagnostic = { error: String(error).slice(0, 2000), pageErrors: restoredPageErrors };
    try {
      diagnostic.restored = await restored.evaluate(() => ({
        path: location.pathname,
        headings: [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].slice(0, 32).map(node => node.textContent?.slice(0, 256)),
        alerts: [...document.querySelectorAll('[role="alert"],[role="status"]')].slice(0, 16).map(node => node.textContent?.slice(0, 512)),
        buttons: [...document.querySelectorAll('button')].slice(0, 80).map(node => ({ text: node.textContent?.slice(0, 128), disabled: node.disabled, pressed: node.getAttribute('aria-pressed') })),
        storage: window.composerRestoreProof?.diagnostics(),
      }));
      await restored.screenshot({ path: `test-results/composer-files-${name}-restore-failure.png`, fullPage: true });
    } catch (captureError) { diagnostic.captureError = String(captureError).slice(0, 512); }
    await writeFile(`test-results/composer-files-${name}-restore-failure.json`, JSON.stringify(diagnostic, null, 2));
    throw error;
  } finally { await restored.close(); }
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  return { title, threadId: state.threadId, messageId: message.id, attachment, parts, sha256, byteLength: original.length, archiveSha256: digest(exported), restoredRegeneration: true, regionalFileRefusedBeforeDispatch: true, regionalImageEligibilityReportRefreshed: true, keyboardRestoreReviewRelease: true };
}

export async function verifyComposerFilesRestart({ page, records, requests, evidence, name }) {
  const before = requests.length;
  await page.getByRole('button', { name: evidence.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: evidence.title, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation messages', exact: true })).toContainText(evidence.attachment.filename);
  expect((await records(page, 'attachments')).items.find(value => value.id === evidence.attachment.id)).toEqual(evidence.attachment);
  expect((await page.evaluate(id => window.appAcceptance.parts(id), evidence.messageId)).items).toEqual(evidence.parts);
  expect(await page.evaluate(sha => window.appAcceptance.attachmentFingerprint(sha), evidence.sha256)).toEqual({ sha256: evidence.sha256, byteLength: evidence.byteLength });
  expect(requests.length).toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/composer-files-${name}-restart.png`, fullPage: true });
}
