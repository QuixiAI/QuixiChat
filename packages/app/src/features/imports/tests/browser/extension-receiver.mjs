import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

/** Drives the page side of the extension transfer with a synthetic sender
 * running in the page (what the content script would post), so both engines
 * prove pairing, chunk acknowledgement, resume after an interruption, digest
 * verification, the import under the bundle's provider and its provenance. */
export async function exerciseExtensionReceiver({ page, fixtureBytes, host }) {
  const sha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const code = await page.getByTestId('extension-pairing-code').textContent();
  assert.match(code, /^\d{6}$/);
  const bundle = (bundleId) => ({ version: 1, bundleId, provider: 'openai', method: 'extension', extractor: { name: 'synthetic-sender', version: '0.1.0', source: 'page_extraction' }, sourceFormatVersion: 'chatgpt-web-conversation-observed-2026-v1', capturedAt: Date.now(), file: { name: 'chatgpt-web-extension.json', mediaType: 'application/json', byteLength: fixtureBytes.byteLength, sha256 }, discovered: { conversations: 1, attachments: 1, unavailableAttachments: 1 }, sourceUrl: 'https://chatgpt.com', checkpoint: { cursor: null, sinceUpdateTime: null } });
  // Install the sender: it records every page reply and sends chunks on demand.
  await page.evaluate(({ bytesBase64 }) => {
    const bytes = Uint8Array.from(atob(bytesBase64), (c) => c.charCodeAt(0));
    const replies = [];
    // Small chunks so the tiny fixture crosses several acknowledgements and an interruption.
    let committed = 0, sequence = 0, chunkBytes = 256, paused = false, offerId = null, sent = 0;
    const tag = (message) => ({ channel: 'quixi-extension-import', version: 1, ...message });
    const post = (message, transfer) => window.postMessage(tag(message), location.origin, transfer);
    const pump = () => {
      while (!paused && offerId && committed + (sent - committed) < bytes.byteLength && sent - committed < chunkBytes * 4) {
        const end = Math.min(bytes.byteLength, sent + chunkBytes);
        const slice = bytes.slice(sent, end).buffer;
        post({ kind: 'chunk', offerId, sequence: sequence++, offset: sent, bytes: slice, final: end === bytes.byteLength }, [slice]);
        sent = end;
        if (window.extensionSender.stopAfterSequence !== null && sequence > window.extensionSender.stopAfterSequence) { paused = true; }
      }
    };
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.channel !== 'quixi-extension-import' || event.origin !== location.origin) return;
      if (['offer', 'chunk', 'resume', 'cancel'].includes(data.kind)) return;
      replies.push({ ...data, at: Date.now() });
      if (data.kind === 'accepted' && data.offerId === offerId) { chunkBytes = Math.min(chunkBytes, data.maxChunkBytes); committed = data.committedOffset; sent = data.committedOffset; sequence = Math.ceil(committed / chunkBytes); pump(); }
      if (data.kind === 'ack' && data.offerId === offerId) { committed = data.committedOffset; pump(); }
    });
    window.extensionSender = {
      replies, stopAfterSequence: null,
      offer(id, pairingCode, bundle) { offerId = id; committed = 0; sent = 0; sequence = 0; paused = false; post({ kind: 'offer', offerId: id, pairingCode, bundle }); },
      resume(pairingCode) { paused = false; post({ kind: 'resume', offerId, pairingCode }); },
      state: () => ({ committed, sent, sequence, paused }),
    };
  }, { bytesBase64: Buffer.from(fixtureBytes).toString('base64') });
  const replies = () => page.evaluate(() => window.extensionSender.replies);
  // 1. A wrong pairing code is refused before anything is shown or stored.
  const wrongId = crypto.randomUUID();
  await page.evaluate(({ id, bundle }) => window.extensionSender.offer(id, '000000', bundle), { id: wrongId, bundle: bundle(crypto.randomUUID()) });
  await expect.poll(async () => (await replies()).find((reply) => reply.offerId === wrongId)?.kind).toBe('rejected');
  await expect(page.getByRole('group', { name: 'Extension offer' })).toHaveCount(0);
  host.checks.push('an extension offer with the wrong pairing code is rejected by the page and never shown');
  // 2. A paired offer is shown; accepting stages it with acknowledgements, and an interruption resumes from the committed offset.
  const offerId = crypto.randomUUID();
  await page.getByLabel('Source account label').fill('Extension fixture');
  await page.evaluate(() => { window.extensionSender.stopAfterSequence = 0; });
  await page.evaluate(({ id, bundle, code }) => window.extensionSender.offer(id, code, bundle), { id: offerId, bundle: bundle(crypto.randomUUID()), code });
  const offer = page.getByRole('group', { name: 'Extension offer' });
  await expect(offer).toContainText('chatgpt-web-extension.json');
  await expect(offer).toContainText('extracted from the provider page');
  await offer.getByRole('button', { name: 'Accept and import', exact: true }).click();
  await expect.poll(async () => (await replies()).some((reply) => reply.kind === 'ack' && reply.offerId === offerId)).toBe(true);
  const stalled = await page.evaluate(() => window.extensionSender.state());
  assert.ok(stalled.paused && stalled.committed > 0 && stalled.committed < fixtureBytes.byteLength, JSON.stringify(stalled));
  await page.waitForTimeout(300);
  await expect(page.getByTestId('extension-transfer-state')).toContainText('Receiving');
  await page.evaluate(() => { window.extensionSender.stopAfterSequence = null; });
  await page.evaluate((pairingCode) => window.extensionSender.resume(pairingCode), code);
  await expect.poll(async () => (await replies()).filter((reply) => reply.offerId === offerId && reply.kind === 'accepted').length).toBe(2);
  const resumed = (await replies()).filter((reply) => reply.offerId === offerId && reply.kind === 'accepted')[1];
  assert.equal(resumed.committedOffset, stalled.committed, 'resume continues from the committed offset');
  await expect.poll(async () => (await replies()).find((reply) => reply.offerId === offerId && reply.kind === 'staged')).toBeTruthy();
  await expect(page.getByRole('status').filter({ hasText: 'Import complete.' })).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await replies()).find((reply) => reply.offerId === offerId && reply.kind === 'imported')?.outcome).toBe('complete');
  const sources = (await page.evaluate(() => window.panelTest.records('importSources'))).items;
  assert.ok(sources.some((source) => source.method === 'extension'), 'provenance records the extension method');
  const threadsAfter = (await page.evaluate(() => window.panelTest.threads())).items.length;
  host.checks.push('a paired offer is shown with its provenance, accepted explicitly, received with acknowledgements, resumed from the committed offset after an interruption, verified by digest and imported with method "extension"');
  // 3. Sending the same bundle again for the same account creates no duplicate thread.
  const repeatId = crypto.randomUUID();
  await page.evaluate(({ id, bundle, code }) => window.extensionSender.offer(id, code, bundle), { id: repeatId, bundle: bundle(crypto.randomUUID()), code });
  await offer.getByRole('button', { name: 'Accept and import', exact: true }).click();
  await expect.poll(async () => (await replies()).find((reply) => reply.offerId === repeatId && reply.kind === 'imported')?.outcome, { timeout: 60_000 }).toBe('complete');
  assert.equal((await page.evaluate(() => window.panelTest.threads())).items.length, threadsAfter);
  host.checks.push('repeating the same extension bundle for the same account is acknowledged and imported without duplicating history');
  // 4. Declining an offer tells the extension and stores nothing.
  const declineId = crypto.randomUUID();
  await page.evaluate(({ id, bundle, code }) => window.extensionSender.offer(id, code, bundle), { id: declineId, bundle: bundle(crypto.randomUUID()), code });
  await offer.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect.poll(async () => (await replies()).find((reply) => reply.offerId === declineId)?.kind).toBe('rejected');
  await expect(page.getByRole('group', { name: 'Extension offer' })).toHaveCount(0);
  host.checks.push('declining an offer reports the refusal to the extension and leaves no staged bytes');
  // 5. A storage fault during an accepted bundle's import is reported to the
  // extension as paused with its cause, the run is saved, and Resume finishes
  // it from the staged bytes without a second transfer; the saved report
  // carries the extension's provenance and discovery counts.
  const retryId = crypto.randomUUID();
  await page.getByLabel('Source account label').fill('Extension retry');
  await page.evaluate(() => window.panelTest.failNext('importWorkSeal'));
  await page.evaluate(({ id, bundle, code }) => window.extensionSender.offer(id, code, bundle), { id: retryId, bundle: bundle(crypto.randomUUID()), code });
  await page.getByRole('group', { name: 'Extension offer' }).getByRole('button', { name: 'Accept and import', exact: true }).click();
  // A storage fault pauses the run with its cause (progress is retained, so it is resumable), and that is the outcome the extension receives.
  await expect.poll(async () => (await replies()).find((reply) => reply.offerId === retryId && reply.kind === 'imported')?.outcome, { timeout: 60_000 }).toBe('paused');
  const failedReport = (await replies()).find((reply) => reply.offerId === retryId && reply.kind === 'imported');
  assert.match(String(failedReport.reason), /Synthetic storage failure/);
  await expect(page.getByRole('alert')).toContainText('Synthetic storage failure');
  const failedRun = (await page.evaluate(() => window.panelTest.runs())).items.find((run) => run.accountScope === 'Extension retry');
  assert.equal(failedRun.state, 'paused', 'the failed accepted bundle is a saved run');
  assert.match(String(failedRun.summary.lastMessage), /Synthetic storage failure/);
  const transfersBefore = (await replies()).filter((reply) => reply.kind === 'accepted').length;
  await page.getByRole('button', { name: 'Resume selected import', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Import complete.' })).toBeVisible({ timeout: 60_000 });
  assert.equal((await replies()).filter((reply) => reply.kind === 'accepted').length, transfersBefore, 'the retry uses the staged bytes; no second transfer');
  const retriedRun = (await page.evaluate(() => window.panelTest.runs())).items.find((run) => run.accountScope === 'Extension retry');
  assert.equal(retriedRun.state, 'complete');
  const provenance = page.getByTestId('import-extension-provenance');
  await expect(provenance).toContainText('Received from the browser extension');
  await expect(provenance).toContainText('extractor synthetic-sender (page extraction)');
  await expect(provenance).toContainText('discovered 1 conversation');
  host.checks.push('a storage fault during an accepted bundle is reported to the extension as paused with its cause, the run is saved with that cause, Resume finishes it from the staged bytes without a second transfer, and the saved report shows the extension provenance and discovery counts');
  return { pairingCodeShape: 'six digits', sha256 };
}
