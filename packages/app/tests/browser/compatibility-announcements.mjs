import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function effects(page) {
  return page.evaluate(async () => {
    const sync = await window.appAcceptance.sync();
    return {
      syncSequence: sync.highWaterSequence,
      commitCalls: window.appAcceptance.requestStats().commit?.calls ?? 0,
      providerDispatches: window.appAcceptance.providerDispatches(),
    };
  });
}

/** Run on the imported ProviderArtifact branch with Anthropic selected. Leaves
 * that branch selected and restores the draft/output limit for later checks. */
export async function exerciseCompatibilityAnnouncements({ page, name }) {
  const report = { scope: 'Actual AppRoot inspection and StorageWorker reads; DOM live-region mutations, not screen-reader utterances.', updates: [] };
  const region = page.getByRole('region', { name: 'Compatibility report', exact: true });
  const live = region.locator('.compatibility-announcement');
  const limit = page.getByLabel('Maximum output tokens', { exact: true });
  const draft = page.getByLabel('Message', { exact: true });
  const originalLimit = await limit.inputValue(), originalDraft = await draft.inputValue();
  const retainedDraft = `Unsent compatibility review ${name}`;
  let watching = false;
  try {
    await expect(region.getByRole('heading', { name: /Switching to Anthropic/ })).toBeVisible();
    await expect(region).toContainText(/Blocked: [1-9]/);
    await expect(region).toContainText('Blocked ProviderArtifact:');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-atomic', 'true');
    await expect(live).not.toHaveText('');
    await expect(region.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    report.initialAnnouncement = await live.textContent();
    report.initialReasons = await region.locator('p').filter({ hasText: /^Blocked ProviderArtifact:/ }).allTextContents();
    expect(report.initialReasons.length).toBeGreaterThan(0);
    const maximum = Number(await limit.getAttribute('max'));
    const values = [512, 768, 1024, 1536, 2048, 4096].filter(value => value <= maximum && String(value) !== originalLimit).slice(0, 3);
    expect(values).toHaveLength(3);
    await draft.fill(retainedDraft);
    await limit.focus();
    report.before = await effects(page);
    await live.evaluate(node => {
      const evidence = { node, changes: [], observer: null };
      evidence.observer = new MutationObserver(records => {
        for (const record of records) {
          if (evidence.changes.length < 64) evidence.changes.push({ type: record.type, text: node.textContent });
        }
      });
      evidence.observer.observe(node, { childList: true, subtree: true, characterData: true });
      window.compatibilityAnnouncementEvidence = evidence;
    });
    watching = true;
    for (const value of [...values, Number(originalLimit)]) {
      await limit.fill(String(value));
      await expect(limit).toHaveAttribute('aria-invalid', 'false');
      await expect(region).toContainText(`requested output ${value.toLocaleString('en-US')}`);
      await expect(region.getByText('Inspecting the active branch…', { exact: true })).toHaveCount(0);
      await expect(region).toContainText('Blocked ProviderArtifact:');
      await expect(region.getByRole('alert')).toHaveCount(0);
      await expect(live).toHaveText(report.initialAnnouncement);
      await expect(limit).toBeFocused();
      await expect(draft).toHaveValue(retainedDraft);
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
      const sameNode = await live.evaluate(node => node === window.compatibilityAnnouncementEvidence.node);
      expect(sameNode).toBe(true);
      expect(await region.locator('p').filter({ hasText: /^Blocked ProviderArtifact:/ }).allTextContents()).toEqual(report.initialReasons);
      report.updates.push({ outputLimit: value, sameNode, announcement: await live.textContent(), focus: 'Maximum output tokens' });
    }
    report.after = await effects(page);
    expect(report.after).toEqual(report.before);
    report.liveMutations = await page.evaluate(() => window.compatibilityAnnouncementEvidence.changes);
    expect(report.liveMutations).toEqual([]);
    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed'; report.error = String(error);
    throw error;
  } finally {
    if (watching) {
      report.liveMutations = await page.evaluate(() => {
        const evidence = window.compatibilityAnnouncementEvidence;
        evidence.observer.disconnect();
        delete window.compatibilityAnnouncementEvidence;
        return evidence.changes;
      });
    }
    await writeFile(`test-results/compatibility-announcements-${name}.json`, JSON.stringify(report, null, 2));
    await draft.fill(originalDraft);
    if (await limit.inputValue() !== originalLimit) await limit.fill(originalLimit);
  }
}
