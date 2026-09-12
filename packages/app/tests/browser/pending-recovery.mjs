import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { keyboardReviewAction } from './review-accessibility.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot(page) {
  return page.evaluate(async () => {
    const collections = {};
    for (const collection of ['threadStates', 'messages', 'parts', 'events', 'contexts', 'generations', 'summaryProposals']) {
      const result = await window.appAcceptance.records(collection);
      if (result.nextCursor) throw new Error(`Pending recovery fixture exceeds bounded ${collection} capture`);
      collections[collection] = result.items;
    }
    return { collections, sync: await window.appAcceptance.sync(), dispatches: window.appAcceptance.providerDispatches() };
  });
}
function summarize(value, originTitle, otherTitle) {
  return {
    threadStates: value.collections.threadStates.filter(row => row.title === originTitle || row.title === otherTitle),
    collections: Object.fromEntries(Object.entries(value.collections).map(([key, items]) => [key, { count: items.length, sha256: digest(items) }])),
    syncSha256: digest(value.sync), highWaterSequence: value.sync.highWaterSequence,
    providerDispatchCount: value.dispatches.length, providerDispatchSha256: digest(value.dispatches),
  };
}

/** Starts after an actual lost summary-commit reply, with its durable result
 * already present. The held reply is fixture timing, not a mocked mutation. */
export async function exercisePendingRecovery({ page, name, originTitle, otherTitle }) {
  if (!/^[a-z0-9-]{1,32}$/.test(name) || !originTitle || !otherTitle || originTitle === otherTitle)
    throw new Error('Invalid pending recovery fixture arguments');
  const recovery = page.getByRole('region', { name: 'Pending change recovery', exact: true });
  const check = recovery.getByRole('button', { name: 'Check pending change', exact: true });
  const workspace = page.getByRole('region', { name: 'Workspace status', exact: true });
  const search = page.getByLabel('Search your history', { exact: true });
  const results = page.getByRole('region', { name: 'Search results', exact: true });
  const originalSearch = { value: await search.inputValue(), resultsVisible: await results.isVisible() };
  // The original durable write must finish before its retry baseline is captured.
  await expect(recovery).toBeVisible();
  const before = await snapshot(page);
  for (const title of [originTitle, otherTitle]) expect(before.collections.threadStates.filter(row => row.title === title)).toHaveLength(1);
  const report = { scope: 'Actual durable lost-summary reply, dedicated recovery across error dismissal, thread navigation and lexical search; one precommit refusal and one held idempotent retry; no extra canonical writes or provider requests.', status: 'running', before: summarize(before, originTitle, otherTitle), stages: [] };
  const threadButton = title => page.locator('.thread-list button').filter({ has: page.getByText(title, { exact: true }) });
  const open = async title => {
    await keyboardReviewAction({ control: threadButton(title) });
    await expect(threadButton(title)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  };
  const assertPending = async stage => {
    await expect(recovery).toBeVisible();
    await expect(recovery.getByRole('heading', { name: 'Pending change', exact: true })).toBeVisible();
    await expect(recovery).toContainText(originTitle);
    await expect(check).toBeEnabled();
    report.stages.push(stage);
  };
  const dismiss = async () => {
    await keyboardReviewAction({ control: workspace.getByRole('button', { name: 'Dismiss', exact: true }) });
    await expect(workspace.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  };
  try {
    await assertPending('initial-unknown-outcome');
    await dismiss();
    await assertPending('ordinary-error-dismissed');
    await open(otherTitle);
    await assertPending('other-thread-selected');
    await search.fill('comet');
    await search.press('Enter');
    await expect(results).toContainText('Text matches');
    await expect(results.getByText('Exact text match', { exact: true }).first()).toBeVisible();
    await assertPending('lexical-search-completed');
    expect(await snapshot(page)).toEqual(before);
    await recovery.screenshot({ path: `test-results/pending-recovery-${name}.png` });

    await page.evaluate(() => window.appAcceptance.rejectNextCommit());
    await keyboardReviewAction({ control: check });
    await expect(recovery).toContainText('The pending change could not be checked. Its outcome is still unknown.');
    await expect(workspace.getByRole('alert')).toHaveCount(0);
    await assertPending('retry-refused-before-commit');
    expect(await snapshot(page)).toEqual(before);

    await page.evaluate(() => window.appAcceptance.holdCommitReply());
    await keyboardReviewAction({ control: check });
    await expect.poll(() => page.evaluate(() => window.appAcceptance.commitReplyWaiting())).toBe(true);
    await expect(check).toBeDisabled();
    await expect(recovery).toContainText(originTitle);
    await open(originTitle);
    await open(otherTitle);
    // Ordinary sidebar navigation retains focus on its initiating button.
    const destination = threadButton(otherTitle);
    await expect(destination).toBeFocused();
    report.stages.push('newer-navigation-while-retry-held');
    await page.evaluate(() => window.appAcceptance.releaseCommitReply());
    await expect.poll(() => page.evaluate(() => window.appAcceptance.commitReplyWaiting())).toBe(false);
    await expect(recovery).toHaveCount(0);
    await expect(threadButton(otherTitle)).toHaveAttribute('aria-current', 'true');
    await expect(destination).toBeFocused();
    const after = await snapshot(page);
    expect(after).toEqual(before);
    report.after = summarize(after, originTitle, otherTitle);
    report.stages.push('retry-completed-without-selection-or-focus-theft');
    report.destination = { title: otherTitle, tag: await destination.evaluate(node => node.tagName), focused: true };

    if (await results.isVisible()) await keyboardReviewAction({ control: results.getByRole('button', { name: 'Close results', exact: true }) });
    await search.fill(originalSearch.value);
    if (originalSearch.resultsVisible) {
      await search.press('Enter');
      await expect(results).toBeVisible();
    }
    await open(originTitle);
    expect(await snapshot(page)).toEqual(before);
    report.searchRestored = originalSearch;
    report.returnedToOrigin = true;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error).slice(0, 2000);
    throw error;
  } finally {
    try { await page.evaluate(() => window.appAcceptance.releaseCommitReply()); }
    finally { await writeFile(`test-results/pending-recovery-${name}.json`, JSON.stringify(report, null, 2)); }
  }
  return report;
}
