import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { keyboardActivate } from './keyboard-focus.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(page) {
  return page.evaluate(async () => {
    const records = {};
    for (const collection of ['threadStates', 'messages', 'parts', 'events', 'contexts', 'generations', 'summaryProposals']) {
      const result = await window.appAcceptance.records(collection);
      if (result.nextCursor) throw new Error(`Health fixture exceeds bounded ${collection} capture`);
      records[collection] = result.items;
    }
    return { records, sync: await window.appAcceptance.sync(), contentDispatches: window.appAcceptance.providerDispatches().filter(value => value.path !== '/v1/models') };
  });
}

export async function exerciseHealthRefresh({ page, name, modelRequests, respond, held, release }) {
  const report = { status: 'running', stages: [], scope: 'Production shared UI, session controller, provider adapters and HTTP/OPFS; synthetic model responses and an advanced health clock, with real visibility/connectivity event handling.' };
  const health = page.locator('.connection-health');
  const message = page.getByLabel('Message', { exact: true });
  const count = () => modelRequests().filter(value => value.provider === 'anthropic').length;
  const advance = milliseconds => page.evaluate(value => window.appAcceptance.advanceHealthClock(value), milliseconds);
  const online = value => page.evaluate(value => {
    Object.defineProperty(navigator, 'onLine', { get: () => value, configurable: true });
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  }, value);
  const visible = value => page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { get: () => value ? 'visible' : 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
  const check = async provider => {
    await page.getByRole('button', { name: 'Providers', exact: true }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: provider, exact: true }) });
    await keyboardActivate(card.getByRole('button', { name: 'Check connection', exact: true }));
    await expect(card.getByText('Credential connected · healthy', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Library', exact: true }).click();
  };
  const before = await snapshot(page), requestsBefore = modelRequests().length;
  try {
    await message.focus();
    respond('anthropic', { status: 503, body: { error: { type: 'api_error', message: 'Synthetic background outage' } } });
    const initialCount = count();
    await advance(301_000);
    await expect(health).toContainText('Anthropic: Provider degraded');
    await expect(health).toContainText('Synthetic background outage');
    await expect(message).toBeFocused();
    expect(count()).toBe(initialCount + 1);
    report.stages.push('automatic-failure-updates-health-without-focus-change');

    await online(false);
    await advance(61_000);
    await expect(health).toContainText('Anthropic: Offline');
    await page.waitForTimeout(150);
    expect(count()).toBe(initialCount + 1);
    await visible(false);
    await online(true);
    await page.waitForTimeout(150);
    expect(count()).toBe(initialCount + 1);
    report.stages.push('overdue-probe-suppressed-while-offline-or-hidden');
    await visible(true);
    await expect(health).toContainText('Anthropic: Healthy · from a connection check');
    expect(count()).toBe(initialCount + 2);
    await expect(message).toBeFocused();
    report.stages.push('visible-online-resume-recovers-with-one-probe');

    respond('anthropic', { status: 401, body: { error: { type: 'authentication_error', message: 'Synthetic rejected background credential' } } });
    await advance(301_000);
    await expect(health).toContainText('Anthropic: Authentication expired');
    const rejectedCount = count();
    await advance(600_000);
    await page.waitForTimeout(150);
    expect(count()).toBe(rejectedCount);
    await check('Anthropic');
    await expect(health).toContainText('Anthropic: Healthy');
    report.stages.push('rejected-credential-pauses-automatic-checks-until-explicit-check');

    respond('anthropic', { hold: true });
    await advance(301_000);
    await expect.poll(() => held('anthropic')).toBe(true);
    await online(false);
    await expect.poll(() => held('anthropic')).toBe(false);
    await online(true);
    await expect(health).toContainText('Anthropic: Healthy');
    report.stages.push('offline-cancels-held-probe-without-poisoning-health');
    await page.screenshot({ path: `test-results/health-refresh-${name}.png` });

    await page.evaluate(() => window.appAcceptance.resetHealthClock());
    await check('OpenAI');
    await check('Anthropic');
    const after = await snapshot(page);
    expect(after).toEqual(before);
    report.canonicalAndContentSha256 = digest(before);
    report.unchangedCanonicalAndContent = true;
    report.modelRequests = modelRequests().slice(requestsBefore);
    expect(report.modelRequests.length).toBeGreaterThanOrEqual(6);
    expect(report.modelRequests.every(value => value.method === 'GET' && value.path === '/v1/models' && value.bodyLength === 0)).toBe(true);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error).slice(0, 2000); throw error;
  } finally {
    release('anthropic');
    await page.evaluate(() => {
      delete navigator.onLine;
      delete document.visibilityState;
      window.appAcceptance.resetHealthClock();
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await writeFile(`test-results/health-refresh-${name}.json`, JSON.stringify(report, null, 2));
  }
  return report;
}
