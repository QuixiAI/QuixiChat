import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { captureReviewLayout, keyboardReviewAction } from './review-accessibility.mjs';

/** Requires Library showing a selected conversation. Fixture registry writes are
 * separate from the read-only open/cancel review; no alias is ever applied. */
export async function exerciseAliasApplicationAccessibility({ page, name, aliasId }) {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error('Invalid alias application artifact name');
  const application = page.getByRole('region', { name: 'Apply routing alias', exact: true });
  await expect(application).toBeVisible();
  const before = await page.evaluate(async () => ({
    registry: await window.appAcceptance.aliases(),
    sync: await window.appAcceptance.sync(),
    dispatches: window.appAcceptance.providerDispatches(),
  }));
  const seeded = !aliasId;
  const alias = seeded ? {
    id: await page.evaluate(() => crypto.randomUUID()),
    name: `SyntheticLongAlias_${'x'.repeat(64)}`.slice(0, 64),
    primary: { provider: 'missing-accessibility-primary', model: 'synthetic-model' },
    candidates: [], requirements: {}, allowPrivacyChange: false,
  } : before.registry.aliases.find(item => item.id === aliasId);
  if (!alias || alias.name.length < 48) throw new Error('Supply a saved alias with a long name or omit aliasId to seed one');
  const report = { scope: 'Production application selector and review at 320 CSS px normal/enlarged text; exact label association, cancelled review, unchanged canonical state and provider traffic. Optional synthetic alias setup/deletion are local-registry writes.', status: 'running', seeded, aliasNameLength: alias.name.length };
  let fixtureCreated = false;
  const navigation = title => keyboardReviewAction({ control: page.getByRole('button', { name: title, exact: true }) });
  try {
    if (seeded) {
      await page.evaluate(({ revision, alias }) => window.appAcceptance.putAlias(revision, alias), { revision: before.registry.revision, alias });
      fixtureCreated = true;
      await navigation('Preferences');
      await keyboardReviewAction({ control: page.getByRole('button', { name: 'Reload aliases', exact: true }) });
      await navigation('Library');
    }
    const reviewRegistry = await page.evaluate(() => window.appAcceptance.aliases());
    const selector = application.getByRole('combobox', { name: 'Routing alias', exact: true });
    await expect(selector).toBeEnabled();
    await expect(selector).toHaveAccessibleName('Routing alias');
    report.label = await selector.evaluate(select => ({
      idPresent: !!select.id,
      labels: [...select.labels].map(label => ({ text: label.textContent.trim(), htmlFor: label.htmlFor, sibling: label.parentElement === select.parentElement })),
      id: select.id,
      ariaLabel: select.getAttribute('aria-label'),
    }));
    expect(report.label.idPresent).toBe(true);
    expect(report.label.labels).toEqual([{ text: 'Routing alias', htmlFor: report.label.id, sibling: true }]);
    expect(report.label.ariaLabel).toBeNull();
    report.closedLayout = await captureReviewLayout({ page, regionName: 'Apply routing alias', name, caseName: 'alias-application-closed', requireBorders: true });
    await selector.focus();
    await selector.selectOption(alias.id);
    await expect(application.getByRole('heading', { name: `Apply ${alias.name}`, exact: true })).toBeVisible();
    await expect(application.getByRole('button', { name: 'Apply alias to conversation', exact: true })).toBeDisabled();
    report.openLayout = await captureReviewLayout({ page, regionName: 'Apply routing alias', name, caseName: 'alias-application-open', requireBorders: true });
    await keyboardReviewAction({
      control: application.getByRole('button', { name: 'Cancel alias application', exact: true }),
      focusAfter: application.getByRole('heading', { name: 'Apply routing alias', exact: true }),
    });
    await expect(selector).toHaveValue('');
    await expect(application.getByRole('heading', { name: `Apply ${alias.name}`, exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.appAcceptance.aliases())).toEqual(reviewRegistry);
    expect(await page.evaluate(() => window.appAcceptance.sync())).toEqual(before.sync);
    expect(await page.evaluate(() => window.appAcceptance.providerDispatches())).toEqual(before.dispatches);
    report.reviewUnchanged = true;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = String(error).slice(0, 2000);
    throw error;
  } finally {
    try {
      if (fixtureCreated) {
        await navigation('Preferences');
        await keyboardReviewAction({ control: page.getByRole('button', { name: 'Reload aliases', exact: true }) });
        const article = page.getByRole('article', { name: `Alias ${alias.name}`, exact: true });
        await keyboardReviewAction({ control: article.getByRole('button', { name: `Delete ${alias.name}`, exact: true }) });
        await keyboardReviewAction({ control: article.getByRole('button', { name: `Confirm delete ${alias.name}`, exact: true }) });
        await expect(article).toHaveCount(0);
        expect(await page.evaluate(() => window.appAcceptance.aliases())).toEqual({ ...before.registry, revision: before.registry.revision + 2 });
        await navigation('Library');
        report.fixtureRemoved = true;
      }
      expect(await page.evaluate(() => window.appAcceptance.sync())).toEqual(before.sync);
      expect(await page.evaluate(() => window.appAcceptance.providerDispatches())).toEqual(before.dispatches);
    } catch (error) {
      report.status = 'failed'; report.cleanupError = String(error).slice(0, 2000);
      throw error;
    } finally {
      await writeFile(`test-results/alias-application-accessibility-${name}.json`, JSON.stringify(report, null, 2));
    }
  }
  return report;
}
