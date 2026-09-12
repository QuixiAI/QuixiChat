import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';

export const defaultInteractions = { showTimestamps: false, showModelBadges: true, composerLayout: 'comfortable', modelSwitcherStyle: 'select' };
export const alternateInteractions = { showTimestamps: true, showModelBadges: false, composerLayout: 'compact', modelSwitcherStyle: 'list' };
const preferenceValue = value => Object.fromEntries(Object.keys(defaultInteractions).map(key => [key, value[key]]));
const saved = page => expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
async function choose(page, value) {
  for (const [label, key] of [['Show message timestamps', 'showTimestamps'], ['Show model badges', 'showModelBadges']]) {
    const control = page.getByLabel(label, { exact: true });
    if (await control.isChecked() !== value[key]) await control.click();
    await saved(page);
    await expect(control).toBeChecked({ checked: value[key] });
  }
  for (const [label, key] of [['Composer layout', 'composerLayout'], ['Model switcher style', 'modelSwitcherStyle']]) {
    await page.getByLabel(label, { exact: true }).selectOption(value[key]);
    await saved(page);
  }
  expect(preferenceValue(await page.evaluate(() => window.appAcceptance.preferences()))).toEqual(value);
}
async function panel(page) {
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preferences', exact: true })).toBeVisible();
  await saved(page);
}
async function verifyDisplay(page, value, connected = true) {
  const form = page.locator('form.composer');
  await expect(form).toHaveAttribute('data-layout', value.composerLayout);
  await expect(page.getByLabel('Message', { exact: true })).toHaveAttribute('rows', value.composerLayout === 'compact' ? '2' : '4');
  if (value.showTimestamps) {
    await expect(page.locator('.message time').first()).toBeVisible();
    const times = await page.locator('.message time').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, datetime: node.getAttribute('datetime') })));
    expect(times.length).toBeGreaterThan(0);
    expect(times.every(value => value.text && value.datetime && Number.isFinite(Date.parse(value.datetime)))).toBe(true);
  } else await expect(page.locator('.message time')).toHaveCount(0);
  if (value.showModelBadges) await expect(page.locator('.message .model-badge').first()).toBeVisible();
  else await expect(page.locator('.message .model-badge')).toHaveCount(0);
  // The preference hides provider/model labels, never the stored attempt state.
  await expect(page.locator('.message.assistant header').first()).toContainText(/complete|stopped|cancelled|partial/);
  if (value.modelSwitcherStyle === 'list') {
    await expect(page.getByRole('group', { name: 'Model choices', exact: true })).toBeVisible();
    await expect(page.getByLabel('Model', { exact: true })).toHaveCount(0);
    if (connected) {
      const current = page.getByRole('radio', { checked: true });
      await expect(current).toHaveCount(1);
      await current.focus();
      await current.press('Space');
      await expect(current).toBeChecked();
      await expect(current).toBeFocused();
    }
  } else {
    await expect(page.getByLabel('Model', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Model choices', exact: true })).toHaveCount(0);
  }
}
async function canonicalSnapshot(page, records) {
  const collections = ['threads', 'threadStates', 'messages', 'parts', 'generations', 'contexts', 'events', 'attachments'];
  const rows = {};
  for (const collection of collections) {
    const result = await records(page, collection);
    expect(result.nextCursor).toBeNull();
    rows[collection] = result.items.sort((a, b) => String(a.id ?? a.threadId).localeCompare(String(b.id ?? b.threadId)));
  }
  const sync = await page.evaluate(() => window.appAcceptance.sync());
  return { sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), syncHighWater: sync.highWaterSequence };
}

export async function exerciseInteractionPreferences({ page, records, requests, countRequests, url, name }) {
  await expect.poll(async () => (await records(page, 'generations')).items.every(value => value.status === 'complete')).toBe(true);
  const composer = page.getByLabel('Message', { exact: true });
  const originalDraft = await composer.inputValue();
  await composer.fill('Synthetic draft survives all interaction preferences.');
  await verifyDisplay(page, defaultInteractions);
  const before = await canonicalSnapshot(page, records);
  const http = { content: requests.length, count: countRequests.length };
  const initial = await page.evaluate(() => window.appAcceptance.preferences());
  await panel(page);
  await page.evaluate(() => window.appAcceptance.losePreferenceReply());
  await page.getByLabel('Show message timestamps', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic lost preference reply after durable write');
  for (const label of ['Show message timestamps', 'Show model badges', 'Composer layout', 'Model switcher style']) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload preferences', exact: true }).click();
  await saved(page);
  await expect(page.getByLabel('Show message timestamps', { exact: true })).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await choose(page, alternateInteractions);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await verifyDisplay(page, alternateInteractions);
  await expect(composer).toHaveValue('Synthetic draft survives all interaction preferences.');
  await page.screenshot({ path: `test-results/interaction-preferences-${name}-alternate.png`, fullPage: true });

  // Another production client wins the revision while this panel retains its
  // reviewed value. The next UI save must fail rather than overwrite that edit.
  await panel(page);
  const stale = await page.evaluate(() => window.appAcceptance.preferences());
  const peer = await page.context().newPage();
  try {
    await peer.goto(url);
    await expect(peer.getByRole('heading', { name: 'Pick up where you left off.', exact: true })).toBeVisible();
    expect(await peer.evaluate(() => window.appAcceptance.preferences())).toEqual(stale);
    const changed = await peer.evaluate(({ revision, preferences }) => window.appAcceptance.setInteractionPreferences(revision, preferences), { revision: stale.revision, preferences: { ...alternateInteractions, showTimestamps: false } });
    await page.getByLabel('Show message timestamps', { exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('changed in another view');
    await expect(page.getByLabel('Composer layout', { exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.appAcceptance.preferences())).toEqual(changed);
    await page.getByRole('button', { name: 'Reload preferences', exact: true }).click();
    await saved(page);
    await expect(page.getByLabel('Show message timestamps', { exact: true })).not.toBeChecked();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await peer.evaluate(() => window.appAcceptance.close());
  } finally { await peer.close(); }
  await choose(page, defaultInteractions);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await verifyDisplay(page, defaultInteractions);
  await expect(composer).toHaveValue('Synthetic draft survives all interaction preferences.');
  expect(await canonicalSnapshot(page, records)).toEqual(before);
  expect({ content: requests.length, count: countRequests.length }).toEqual(http);
  const final = await page.evaluate(() => window.appAcceptance.preferences());
  expect(final.sendKey).toBe(initial.sendKey);
  expect(final.revision).toBeGreaterThan(initial.revision);
  await composer.fill(originalDraft);
  return { canonicalSha256: before.sha256, syncHighWater: before.syncHighWater, initialRevision: initial.revision, finalRevision: final.revision, lostReplyRecovered: true, staleUiEditRefused: true, unchangedHttp: http };
}

export async function prepareInteractionPreferencesRestart(page) {
  await panel(page);
  await choose(page, alternateInteractions);
  const value = await page.evaluate(() => window.appAcceptance.preferences());
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  return value;
}

export async function verifyInteractionPreferencesRestart({ page, requests, countRequests, expected, name }) {
  const http = { content: requests.length, count: countRequests.length };
  expect(await page.evaluate(() => window.appAcceptance.preferences())).toEqual(expected);
  await verifyDisplay(page, alternateInteractions, false);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/interaction-preferences-${name}-restart.png`, fullPage: true });
  await panel(page);
  await choose(page, defaultInteractions);
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  expect({ content: requests.length, count: countRequests.length }).toEqual(http);
}
