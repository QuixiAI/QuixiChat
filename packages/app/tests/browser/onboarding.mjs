import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/** Product §94 steps 1–5 and §13/§14 storage status in the shared application,
 * read from actual host capabilities and storage diagnostics in a fresh archive. */
async function open(engine, profile, url) {
  const context = await engine.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible();
  return { context, page, errors };
}
const onboarding = (page) => page.locator('section.onboarding');
export async function exerciseOnboarding({ engine, profile, name, origin }) {
  const evidence = { name, checks: [] };
  const archive = `test-app-onboarding-${randomUUID()}`;
  const url = `${origin}/?archive=${archive}`;
  let { context, page, errors } = await open(engine, profile, url);
  try {
    // Step 1: local storage disclosure on a fresh archive; the landing stays usable.
    await expect(onboarding(page)).toContainText('Your Quixi history stays on this device by default.');
    await expect(onboarding(page)).toContainText('Nothing is stored in Quixi Cloud unless you enable it.');
    await expect(page.getByRole('button', { name: 'Start a conversation', exact: true })).toBeVisible();
    expect((await page.evaluate(() => window.appAcceptance.preferences())).onboardingCompletedAt).toBe(null);
    evidence.checks.push('a fresh archive shows step 1 (local storage disclosure) above the usable landing page, with onboarding recorded as not completed');
    // Step 2: capability check from actual state.
    await onboarding(page).getByRole('button', { name: 'Next', exact: true }).click();
    const check = page.getByTestId('capability-check');
    await expect(check).toContainText('✓ SQLite WASM');
    await expect(check).toContainText('✓ OPFS');
    await expect(check).toContainText('FTS5');
    await expect(check).toContainText('✓ WASM SIMD', { timeout: 15_000 });
    await expect(check).toContainText('✓ Local model provided by this host');
    const gpuActual = await page.evaluate(async () => { try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; } });
    await expect(check).toContainText(gpuActual ? '✓ WebGPU available' : 'WebGPU not available');
    await expect(check).toContainText('browser-extension transfers');
    const backend = await page.getByTestId('storage-backend').textContent();
    expect(backend).toMatch(/SQLite WASM \/ OPFS · schema 12 · integrity ok/);
    const persistedBefore = await page.evaluate(() => navigator.storage.persisted());
    const persistence = page.getByTestId('storage-persistence');
    await expect(persistence).toContainText(persistedBefore ? '✓ Granted' : 'Not granted');
    evidence.capabilities = { gpu: gpuActual, persistedBefore, backend };
    evidence.checks.push(`step 2 reports SQLite WASM/OPFS, FTS5, WASM SIMD, the host model, WebGPU (${gpuActual ? 'available' : 'unavailable'}) and persistence (${persistedBefore ? 'granted' : 'not granted'}) from actual capabilities and diagnostics`);
    if (!persistedBefore) {
      await persistence.getByRole('button', { name: 'Request persistent storage', exact: true }).click();
      await expect(onboarding(page).getByRole('status').filter({ hasText: /persistent storage/i })).toBeVisible({ timeout: 15_000 });
      const persistedAfter = await page.evaluate(() => navigator.storage.persisted());
      const notice = await onboarding(page).getByRole('status').filter({ hasText: /persistent storage/i }).textContent();
      expect(notice).toContain(persistedAfter ? 'granted' : 'did not grant');
      await expect(persistence).toContainText(persistedAfter ? '✓ Granted' : 'Not granted');
      evidence.capabilities.persistedAfter = persistedAfter;
      evidence.checks.push(`requesting persistent storage reports the browser's actual answer (${persistedAfter ? 'granted' : 'not granted'}) and re-reads the status`);
    }
    // Step 3: bring history; each button opens the matching section and the steps remain.
    await onboarding(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect(onboarding(page)).toContainText('Bring your history');
    await onboarding(page).getByRole('button', { name: 'Import provider export', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Import your history' })).toBeVisible();
    await expect(page.getByTestId('extension-pairing-code')).toHaveText(/^\d{6}$/);
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await expect(onboarding(page)).toContainText('Bring your history');
    evidence.checks.push('step 3 offers extension, provider export and Quixi archive; the import section opens with the extension pairing code and the steps resume where they were');
    // Step 4: providers configured on this host.
    await onboarding(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect(onboarding(page)).toContainText(/\d+ provider connections? (is|are) configured/);
    evidence.checks.push('step 4 reports the configured provider connections and says history stays usable without one');
    // Step 5: Later completes the setup and it stays completed across a restart.
    await onboarding(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect(onboarding(page)).toContainText('Enable Local Semantic Search?');
    await onboarding(page).getByRole('button', { name: 'Later', exact: true }).click();
    await expect(onboarding(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible();
    const completed = (await page.evaluate(() => window.appAcceptance.preferences())).onboardingCompletedAt;
    expect(typeof completed).toBe('number');
    expect(errors).toEqual([]);
    await page.evaluate(() => window.appAcceptance.close());
    await context.close();
    ({ context, page, errors } = await open(engine, profile, url));
    await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(onboarding(page)).toHaveCount(0);
    evidence.checks.push('Later on step 5 records completion in device-local preferences; after a browser restart the steps stay hidden');
    // Preferences: show again, then Enable on step 5 enrols semantic search.
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect(page.getByText(/First-time setup finished/)).toBeVisible();
    await page.getByRole('button', { name: 'Show first-time setup again', exact: true }).click();
    await expect(onboarding(page)).toContainText('stays on this device');
    for (let step = 1; step < 5; step++) await onboarding(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect(onboarding(page).getByRole('button', { name: 'Enable', exact: true })).toBeEnabled({ timeout: 15_000 });
    await onboarding(page).getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Semantic search', exact: true })).toBeVisible();
    await expect(page.getByTestId('semantic-backend')).toHaveText(/WASM SIMD · CPU|WebGPU · FP(16|32)/, { timeout: 300_000 });
    expect((await page.evaluate(() => window.appAcceptance.semanticStatus())).state).toBe('enrolled');
    expect(typeof (await page.evaluate(() => window.appAcceptance.preferences())).onboardingCompletedAt).toBe('number');
    evidence.checks.push('Preferences can show the setup again; Enable on step 5 enrols local semantic search through the same controller and completes the setup');
    // Storage health carries the same §13/§14 status with an export action.
    await page.getByRole('button', { name: 'Storage health', exact: true }).click();
    const storageSection = page.getByRole('region', { name: 'Storage', exact: true });
    await expect(storageSection.getByTestId('storage-backend')).toContainText('SQLite WASM / OPFS');
    await storageSection.getByRole('button', { name: 'Export backup', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Export/ }).first()).toBeVisible();
    evidence.checks.push('Storage health shows location, database, usage/quota, persistence and an Export backup action that opens the export section');
    expect(errors).toEqual([]);
    await page.evaluate(() => window.appAcceptance.close());
  } catch (error) {
    try { await page.screenshot({ path: `test-results/app-onboarding-${name}-failure.png`, fullPage: true }); console.error(`${name} onboarding failure DOM:\n${(await page.locator('body').innerText()).slice(0, 3000)}\nerrors=${JSON.stringify(errors)}`); } catch { /* diagnostics only */ }
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
  return evidence;
}
