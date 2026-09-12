import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { keyboardReviewAction } from './review-accessibility.mjs';

export async function exerciseAliasRemovalFocus({ page, name }) {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error('Invalid alias focus artifact name');
  const before = await page.evaluate(() => window.appAcceptance.aliases());
  expect(before.aliases).toEqual([]);
  const dispatchesBefore = await page.evaluate(() => window.appAcceptance.providerDispatches());
  const alias = {
    id: await page.evaluate(() => crypto.randomUUID()), name: 'Synthetic removal focus',
    primary: { provider: 'missing-focus-primary', model: 'synthetic-primary' },
    candidates: ['first', 'middle', 'last'].map(position => ({ provider: `missing-focus-${position}`, model: `synthetic-${position}` })),
    requirements: {}, allowPrivacyChange: false,
  };
  const evidence = { scope: 'Synthetic temporary alias in the production local registry; keyboard removal and confirmation focus, with no provider dispatch.', initialRevision: before.revision, stages: [] };
  const panel = page.getByRole('region', { name: 'Routing aliases', exact: true });
  const heading = panel.getByRole('heading', { name: 'Routing aliases', exact: true });
  const editor = panel.getByRole('form', { name: 'Routing alias editor', exact: true });
  const list = editor.getByRole('list', { name: 'Edit alias fallback order', exact: true });
  const capture = async (stage, remaining) => evidence.stages.push({ stage, remaining, ...await page.evaluate(() => ({ activeTag: document.activeElement?.tagName, activeText: document.activeElement === document.body ? 'BODY' : document.activeElement?.textContent?.trim().slice(0, 160) })) });
  try {
    const seeded = await page.evaluate(({ revision, alias }) => window.appAcceptance.putAlias(revision, alias), { revision: before.revision, alias });
    expect(seeded).toEqual({ ...before, revision: before.revision + 1, aliases: [alias] });
    await keyboardReviewAction({ control: page.getByRole('button', { name: 'Preferences', exact: true }) });
    await keyboardReviewAction({ control: panel.getByRole('button', { name: 'Reload aliases', exact: true }) });
    await keyboardReviewAction({ control: panel.getByRole('button', { name: `Edit ${alias.name}`, exact: true }) });
    await expect(editor.getByLabel('Alias name', { exact: true })).toBeFocused();
    await expect(list.getByRole('listitem')).toHaveCount(3);
    for (const [stage, buttonName, remaining] of [
      ['remove-middle', 'Remove fallback 2', [alias.candidates[0], alias.candidates[2]]],
      ['remove-first', 'Remove fallback 1', [alias.candidates[2]]],
      ['remove-last', 'Remove fallback 1', []],
    ]) {
      await keyboardReviewAction({ control: editor.getByRole('button', { name: buttonName, exact: true }), focusAfter: heading });
      const rows = list.getByRole('listitem');
      await expect(rows).toHaveCount(remaining.length);
      for (let index = 0; index < remaining.length; index++) {
        await expect(rows.nth(index)).toContainText(`${remaining[index].provider} · ${remaining[index].model} (not configured)`);
      }
      await capture(stage, remaining.map(target => target.provider));
    }
    await keyboardReviewAction({ control: editor.getByRole('button', { name: 'Cancel alias edit', exact: true }), focusAfter: heading });
    await expect(editor).toHaveCount(0);
    expect(await page.evaluate(() => window.appAcceptance.aliases())).toEqual(seeded);
    const article = panel.getByRole('article', { name: `Alias ${alias.name}`, exact: true });
    await expect(article.getByRole('list', { name: 'Alias fallback order', exact: true }).getByRole('listitem')).toHaveCount(3);
    await capture('cancel-preserves-all-saved-candidates', alias.candidates.map(target => target.provider));

    await keyboardReviewAction({ control: article.getByRole('button', { name: `Delete ${alias.name}`, exact: true }) });
    await keyboardReviewAction({ control: article.getByRole('button', { name: 'Keep alias', exact: true }), focusAfter: heading });
    await expect(article.getByRole('button', { name: `Confirm delete ${alias.name}`, exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.appAcceptance.aliases())).toEqual(seeded);
    await capture('keep-dismisses-confirmation', alias.candidates.map(target => target.provider));

    await keyboardReviewAction({ control: article.getByRole('button', { name: `Delete ${alias.name}`, exact: true }) });
    await keyboardReviewAction({ control: article.getByRole('button', { name: `Confirm delete ${alias.name}`, exact: true }), focusAfter: heading });
    await expect(article).toHaveCount(0);
    const after = await page.evaluate(() => window.appAcceptance.aliases());
    expect(after).toEqual({ ...before, revision: before.revision + 2 });
    expect(await page.evaluate(() => window.appAcceptance.providerDispatches())).toEqual(dispatchesBefore);
    await capture('last-alias-deleted', []);
    evidence.finalRevision = after.revision;
    evidence.providerDispatchCount = dispatchesBefore.length;
    evidence.status = 'passed';
    await panel.screenshot({ path: `test-results/alias-removal-focus-${name}.png` });
    await keyboardReviewAction({ control: page.getByRole('button', { name: 'Library', exact: true }) });
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error).slice(0, 2000);
    await capture('failure', []);
    throw error;
  } finally {
    await writeFile(`test-results/alias-removal-focus-${name}.json`, JSON.stringify(evidence, null, 2));
  }
  return evidence;
}
