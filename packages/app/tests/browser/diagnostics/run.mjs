import { browserEngines } from '../../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, release, arch } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const selected = browserEngines({ chromium, webkit }), temporary = await mkdtemp(resolve(tmpdir(), 'quixi-storage-health-'));
const proof = { status: 'running', startedAt: new Date().toISOString(), selectedEngines: selected.map(([name]) => name), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, scope: 'Production AppRoot/storage-health controller and panel with real isolated OPFS/SQLite workers. Test-only corruption helper creates synthetic fixtures before mounting. The explicit owner-loss case replaces its real isolated client; worker results are never mocked. No file or canonical cleanup is offered by the product.', hosts: [], sourceSha256: {} };
let server;
const save = async () => { await mkdir('test-results', { recursive: true }); await writeFile('test-results/app-storage-health-browser.json', JSON.stringify(proof, null, 2) + '\n'); };
const sourceFiles = [
  'packages/app/src/AppRoot.tsx', 'packages/app/src/features/diagnostics/controller.ts', 'packages/app/src/features/diagnostics/StorageHealthPanel.tsx', 'packages/app/src/features/diagnostics/diagnostics.css',
  'packages/app/tests/browser/diagnostics/index.ts', 'packages/app/tests/browser/diagnostics/index.html', 'packages/app/tests/browser/diagnostics/run.mjs',
  'packages/core/src/contracts/blob-inventory.ts', 'packages/core/src/contracts/storage.ts', 'packages/storage/tests/blob-inventory/fixture.ts', 'packages/storage/tests/blob-inventory/fixture-worker.ts',
  'packages/storage/tests/isolated-client.ts', 'packages/storage/tests/isolated-worker.ts', 'packages/storage/src/worker/archive-runtime.ts', 'packages/storage/src/worker/archive-database.ts',
  'packages/storage/src/worker/blob-inventory.ts', 'packages/storage/src/worker/blobs.ts', 'packages/storage/src/worker/blob-catalog.ts', 'tooling/browser-engines.mjs', 'package-lock.json',
];
const inventory = page => page.evaluate(() => window.storageHealthAcceptance.calls());
const panel = page => page.getByRole('region', { name: 'Storage health', exact: true });
const complete = async page => { await expect(panel(page).getByRole('status')).toContainText('Scan complete.', { timeout: 30000 }); await expect(panel(page).getByRole('list', { name: 'Storage findings', exact: true }).getByRole('listitem')).toHaveCount(32); };
const labels = ['Referenced file missing', 'File metadata missing', 'Unreferenced stored file', 'File size differs', 'File retained for transfer or import', 'Temporary staged file', 'Unrecognized storage entry'];
try {
  for (const file of sourceFiles) proof.sourceSha256[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  const outDir = resolve(temporary, 'dist'); await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: 'warn' });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: '127.0.0.1', port: 4199, strictPort: true }, logLevel: 'warn' });
  for (const [name, engine] of selected) {
    const evidence = { name, status: 'running', checks: [], requestBounds: null }; proof.hosts.push(evidence);
    const context = await engine.launchPersistentContext(resolve(temporary, name), { headless: true, viewport: { width: 1280, height: 900 } }), errors = [];
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    const open = async () => {
      await page.goto(`http://127.0.0.1:4199/?archive=test-health-${randomUUID()}`);
      await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled({ timeout: 30000 });
      await expect.poll(() => page.evaluate(() => !!window.storageHealthAcceptance)).toBe(true);
    };
    try {
      await open(); const baseline = await page.evaluate(() => window.storageHealthAcceptance.fixture.baseline);
      expect(await inventory(page)).toHaveLength(0);
      await page.getByRole('button', { name: 'Storage health', exact: true }).click(); expect(await inventory(page)).toHaveLength(0);
      await panel(page).getByRole('button', { name: 'Start storage scan', exact: true }).focus(); await page.keyboard.press('Enter');
      await expect(panel(page).getByRole('button', { name: 'Stop scan', exact: true })).toBeVisible();
      await panel(page).getByRole('button', { name: 'Stop scan', exact: true }).focus(); await page.keyboard.press('Enter');
      await expect(panel(page).getByRole('status')).toContainText('Scan stopped.');
      evidence.checks.push('Opening Storage health performs no inventory work; keyboard start and stop cancel a real bounded worker scan without showing partial findings');
      await panel(page).getByRole('button', { name: 'Start a new scan', exact: true }).click();
      await expect.poll(async () => (await inventory(page)).filter(call => call.operation === 'beginBlobInventory').length).toBe(2);
      await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: 'Storage health', exact: true }).click();
      await complete(page); expect((await inventory(page)).filter(call => call.operation === 'beginBlobInventory')).toHaveLength(2);
      evidence.checks.push('Navigating away and back retains the same active scan and completes without automatically starting another scan');
      for (const label of labels) await expect(panel(page).locator('.storage-health-counts dt').filter({ hasText: label })).toHaveCount(1);
      const counts = await panel(page).locator('.storage-health-counts dd').allTextContents(); expect(counts.every(value => Number(value.replaceAll(',', '')) > 0)).toBe(true);
      await expect(panel(page)).not.toContainText('unrecognized-private-name.txt'); await expect(panel(page)).not.toContainText('unrecognized-stage-name.tmp'); await expect(panel(page)).not.toContainText('private-child.txt'); await expect(panel(page)).not.toContainText('Original bytes must remain unchanged');
      expect(await panel(page).getByRole('button').allTextContents()).toEqual(['Start a new scan', 'First findings', 'Next findings']);
      evidence.checks.push('All seven finding categories have counts and plain-language guidance; managed identifiers reveal no synthetic private names or original content and no deletion control exists');
      const firstDigest = await panel(page).getByRole('list', { name: 'Storage findings', exact: true }).getAttribute('start');
      await panel(page).getByRole('button', { name: 'Next findings', exact: true }).focus(); await page.keyboard.press('Enter');
      await expect(panel(page).getByRole('heading', { name: 'Storage findings', exact: true })).toBeFocused();
      expect(await panel(page).getByRole('list', { name: 'Storage findings', exact: true }).getAttribute('start')).not.toBe(firstDigest);
      await expect(panel(page).getByRole('list', { name: 'Storage findings', exact: true }).getByRole('listitem')).toHaveCount(32);
      await panel(page).getByRole('button', { name: 'First findings', exact: true }).click(); await expect(panel(page).getByRole('list', { name: 'Storage findings', exact: true })).toHaveAttribute('start', '1');
      evidence.checks.push('Keyboard pagination replaces one bounded page and returns focus to the results heading; First findings returns to the first page');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await panel(page).evaluate(element => element.scrollIntoView({ block: 'start' })); await page.screenshot({ path: `test-results/storage-health-${name}-mobile.png` }); await page.setViewportSize({ width: 1280, height: 900 });
      evidence.checks.push('Long managed digests wrap within the narrow layout without horizontal page overflow');
      const calls = await inventory(page), advances = calls.filter(call => call.operation === 'advanceBlobInventory'), pages = calls.filter(call => call.operation === 'readBlobInventoryFindings');
      expect(advances.length).toBeGreaterThan(1); expect(advances.every(call => call.maxItems === 64)).toBe(true);
      expect(pages.every(call => call.maxItems === 32 && call.maxBytes === 16384 && call.responseItems <= 32 && call.responseBytes <= 16384)).toBe(true);
      evidence.requestBounds = { advances: advances.length, maxAdvanceItems: 64, findingPages: pages.length, maxPageItems: 32, maxPageBytes: 16384 };
      const after = await page.evaluate(() => window.storageHealthAcceptance.fingerprint()); expect(after).toEqual(baseline); evidence.baseline = baseline; evidence.after = after;
      evidence.checks.push('Real scan, cancellation and pagination leave canonical rows, sync/blob operation records and every original/staged/unrecognized fixture byte unchanged');
      await page.evaluate(() => window.storageHealthAcceptance.cleanup());
      await open(); await page.getByRole('button', { name: 'Storage health', exact: true }).click(); await panel(page).getByRole('button', { name: 'Start storage scan', exact: true }).click(); await complete(page);
      await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Storage health', exact: true }).click(); await expect(panel(page).getByRole('alert')).toContainText('Storage changed');
      await expect(panel(page).getByRole('list', { name: 'Storage findings', exact: true })).toHaveCount(0);
      await panel(page).getByRole('button', { name: 'Start a new scan', exact: true }).click(); await complete(page);
      await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.evaluate(() => window.storageHealthAcceptance.restartOwner());
      await page.getByRole('button', { name: 'Storage health', exact: true }).click(); await expect(panel(page).getByRole('alert')).toContainText('This scan is no longer available');
      await expect(panel(page).getByRole('list', { name: 'Storage findings', exact: true })).toHaveCount(0);
      await panel(page).getByRole('button', { name: 'Start a new scan', exact: true }).click(); await complete(page);
      evidence.checks.push('A real canonical change immediately hides stale findings; replacing the real storage owner also discards unavailable results and both require an explicit successful new scan');
      expect(errors).toHaveLength(0); evidence.status = 'passed';
    } catch (error) {
      evidence.status = 'failed'; evidence.error = String(error?.stack ?? error); evidence.pageErrors = errors;
      evidence.calls = await inventory(page).catch(() => []); await page.screenshot({ path: `test-results/storage-health-${name}-failure.png`, fullPage: true }).catch(() => {}); throw error;
    } finally { await page.evaluate(() => window.storageHealthAcceptance?.cleanup()).catch(() => {}); await context.close(); }
    await save();
  }
  proof.changedSources = [];
  for (const [file, digest] of Object.entries(proof.sourceSha256)) if (createHash('sha256').update(await readFile(file)).digest('hex') !== digest) proof.changedSources.push(file);
  proof.sourceStable = proof.changedSources.length === 0;
  expect(proof.changedSources).toEqual([]);
  proof.status = 'passed';
} catch (error) { proof.status = 'failed'; proof.error = String(error?.stack ?? error); process.exitCode = 1; }
finally { proof.finishedAt = new Date().toISOString(); await save(); await server?.httpServer.close(); await rm(temporary, { recursive: true, force: true }); console.log(JSON.stringify({ status: proof.status, hosts: proof.hosts.map(value => ({ name: value.name, status: value.status, checks: value.checks.length })), error: proof.error ?? null }, null, 2)); }
