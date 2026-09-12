import { chromium, webkit, expect } from '@playwright/test';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, open as openFile, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir, platform, release, arch } from 'node:os';
import { resolve } from 'node:path';
import { browserEngines } from '../../../../../../../tooling/browser-engines.mjs';

const root = resolve(import.meta.dirname, '../../../../../../../');
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-document-ui-'));
const results = resolve(import.meta.dirname, 'results');
const engines = browserEngines({ chromium, webkit });
const report = { status: 'running', startedAt: new Date().toISOString(), selectedEngines: engines.map(([name]) => name),
  environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, sourceSha256: {}, hosts: [],
  qualification: 'Production web main, shared app, actual host file picker, PDF.js, managed StorageClient and OPFS. One real page-index reply is deliberately held/released to make cancellation and early navigation deterministic. No provider calls.' };
const save = async () => { await mkdir(results, { recursive: true }); await writeFile(resolve(results, 'document-ui-browser.json'), JSON.stringify(report, null, 2) + '\n'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const snapshot = page => page.evaluate(() => window.documentAcceptance.snapshot());
const runFor = (state, documentId) => state.runs.find(run => run?.identity.documentId === documentId);
async function importPdf(page, name) {
  const chooser = page.waitForEvent('filechooser');
  await button(page, 'Import PDF').click();
  await (await chooser).setFiles(resolve(root, 'packages/documents/tests/fixtures', name));
  await expect(page.getByRole('heading', { name: name.replace(/\.pdf$/i, ''), exact: true })).toBeVisible({ timeout: 30000 });
  await expect(button(page, 'Extract text')).toBeEnabled();
}
async function search(page, query) {
  await button(page, 'Library').click();
  await page.getByLabel('Search your history', { exact: true }).fill(query);
  await button(page, 'Search').click();
  await expect(page.getByRole('region', { name: 'Search results' })).toBeVisible();
}
let server;
try {
  await save();
  const oversizedFile = resolve(temporary, 'oversized.pdf');
  const oversizedHandle = await openFile(oversizedFile, 'wx');
  try { await oversizedHandle.truncate(32 * 1024 * 1024 + 1); } finally { await oversizedHandle.close(); }
  for (const file of [
    'package-lock.json', 'apps/web/src/main.ts', 'apps/web/src/host/index.ts', 'apps/web/src/host/transfers.ts',
    'packages/app/src/AppRoot.tsx', 'packages/app/src/features/documents/DocumentPanel.tsx',
    'packages/app/src/features/documents/controller.ts', 'packages/app/src/features/documents/import-pdf.ts',
    'packages/app/src/features/documents/documents.css', 'packages/documents/src/persist.ts',
    'packages/documents/src/persist-mutation.ts', 'packages/documents/src/clear.ts', 'packages/documents/src/storage.ts',
    'packages/core/src/contracts/extraction.ts', 'packages/storage/src/worker/extraction/index.ts',
    'packages/storage/src/worker/extraction/schema.ts', 'packages/documents/src/contracts.ts',
    'node_modules/pdfjs-dist/build/pdf.worker.mjs',
    'packages/documents/tests/fixtures/low-text.pdf',
    'packages/documents/tests/fixtures/encrypted.pdf', 'packages/documents/tests/fixtures/malformed.pdf',
    'packages/documents/tests/fixtures/pages-1001.pdf', 'packages/documents/tests/fixtures/dense-page.pdf',
    'packages/documents/tests/fixtures/pages-100.pdf', 'packages/documents/tests/fixtures/scanned.pdf',
    'packages/documents/src/layout.ts', 'packages/documents/src/worker/index.ts',
    'packages/documents/tests/fixtures/layout-columns.pdf', 'packages/documents/tests/fixtures/layout-table-code.pdf',
    'packages/documents/tests/fixtures/layout-unsupported.pdf',
    'packages/storage/src/client/reconcile-retained.ts', 'packages/storage/src/client/retained-archive.ts',
    'packages/storage/src/client/reconcile-extraction.ts',
    'packages/storage/src/worker/retained-archive.ts',
    'packages/documents/src/storage-source.ts', 'packages/storage/src/worker/archive-database.ts',
    'packages/storage/src/worker/search/index.ts', 'packages/storage/src/worker/search/navigation.ts',
    'packages/core/src/contracts/search.ts', 'packages/core/src/contracts/storage.ts',
    'packages/app/src/features/documents/tests/browser/index.ts', 'packages/app/src/features/documents/tests/browser/run.mjs',
  ]) report.sourceSha256[file] = hash(await readFile(resolve(root, file)));
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, logLevel: 'warn', worker: { format: 'es' }, build: { outDir, emptyOutDir: true, target: 'esnext' } });
  server = await preview({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  report.origin = origin;
  for (const [name, engine] of engines) {
    const host = { name, status: 'running', checks: [], pageErrors: [], remoteRequests: [] };
    report.hosts.push(host); await save();
    const profile = resolve(temporary, name);
    let context;
    const launch = async () => {
      context = await engine.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 960 } });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== origin) { host.remoteRequests.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', error => host.pageErrors.push(String(error)));
      page.setDefaultTimeout(20000);
      await page.goto(origin);
      await expect(button(page, 'New conversation').first()).toBeEnabled({ timeout: 30000 });
      return page;
    };
    let page;
    const failedPdfRecovery = async (fixture, reason, message) => {
      await importPdf(page, fixture); await button(page, 'Extract text').click();
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 30000 });
      if (fixture === 'pages-1001.pdf') await expect(page.getByRole('alert')).toContainText('1000-page extraction limit');
      await expect(button(page, 'Retry extraction')).toBeEnabled();
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(page.getByText('No pages saved yet.', { exact: true })).toBeVisible();
      const before = await snapshot(page);
      const document = before.documents.find(item => item.title === fixture.replace(/\.pdf$/, ''));
      expect(document).toBeTruthy();
      const failed = runFor(before, document.id);
      expect(failed).toMatchObject({ state: 'interrupted', failure: reason, completedPage: 0 });
      const originalHash = hash(await readFile(resolve(root, 'packages/documents/tests/fixtures', fixture)));
      expect(await page.evaluate(id => window.documentAcceptance.verifyOriginal(id), document.id)).toBe(originalHash);
      await context.close(); page = await launch();
      await button(page, 'Documents').click(); await button(page, document.title).click();
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(button(page, 'Retry extraction')).toBeEnabled();
      expect(runFor(await snapshot(page), document.id)).toMatchObject({
        runId: failed.runId, writerEpoch: failed.writerEpoch, state: 'interrupted', failure: reason, completedPage: 0,
      }); // Reopening must not admit another producer or retry automatically.
      await page.getByLabel('Page number', { exact: true }).fill('1'); await button(page, 'Open page').click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Document page 1', exact: true })).toHaveCount(0);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await button(page, 'Retry extraction').click();
      await expect(page.getByRole('alert')).toBeVisible({ timeout: 30000 });
      await expect(button(page, 'Retry extraction')).toBeEnabled();
      const retried = runFor(await snapshot(page), document.id);
      expect(retried).toMatchObject({ runId: failed.runId, state: 'interrupted', failure: reason, completedPage: 0 });
      expect(retried.writerEpoch).toBeGreaterThan(failed.writerEpoch);
      await page.screenshot({ path: resolve(results, `${name}-${fixture.replace(/\.pdf$/, '')}-recovery.png`), fullPage: true });
      await button(page, 'Clear saved text…').click(); await button(page, 'Clear saved text').click();
      await expect(button(page, 'Extract text')).toBeEnabled();
      await expect(page.getByText(message, { exact: true })).toHaveCount(0);
      expect(runFor(await snapshot(page), document.id)).toMatchObject({ runId: failed.runId, state: 'cleared', failure: null, visibleRunId: null });
      expect(await page.evaluate(id => window.documentAcceptance.verifyOriginal(id), document.id)).toBe(originalHash);
    };
    try {
      page = await launch(); host.userAgent = await page.evaluate(() => navigator.userAgent);
      expect((await snapshot(page)).documents).toHaveLength(0);
      await button(page, 'Documents').click();
      const oversizedChooser = page.waitForEvent('filechooser');
      await button(page, 'Import PDF').click(); await (await oversizedChooser).setFiles(oversizedFile);
      await expect(page.getByRole('alert')).toContainText('32 MiB');
      await expect(button(page, 'Import PDF')).toBeEnabled();
      expect((await snapshot(page)).documents).toHaveLength(0);
      host.checks.push('Actual file-picker admission rejects a32MiB+1-byte PDF with the size limit and no canonical document; a supported import remains available.');
      await importPdf(page, 'pages-100.pdf');
      const document = (await snapshot(page)).documents[0];
      expect(await page.evaluate(id => window.documentAcceptance.verifyOriginal(id), document.id)).toBe(hash(await readFile(resolve(root, 'packages/documents/tests/fixtures/pages-100.pdf'))));
      host.checks.push('Actual host-selected PDF is atomically registered with verified byte-exact original; no extraction required for durable import.');

      await page.evaluate(() => window.documentAcceptance.arm());
      await button(page, 'Extract text').click();
      await page.waitForFunction(() => window.documentAcceptance.held(), null, { timeout: 30000 });
      await button(page, 'New conversation').click();
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent message while document extraction is active.');
      await search(page, '"Quixi document fixture page 1"');
      const first = page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: 'pages-100', exact: true }).first();
      await expect(first).toBeEnabled(); await first.click();
      await expect(page.getByRole('region', { name: 'Document page 1', exact: true })).toContainText('Quixi document fixture page 1');
      await expect(page.locator('.document-text mark')).toContainText('Quixi document fixture page 1');
      await button(page, 'Stop document work').click();
      await page.evaluate(() => window.documentAcceptance.release());
      await expect(button(page, 'Resume extraction')).toBeEnabled({ timeout: 30000 });
      const interrupted = (await snapshot(page)).runs[0];
      expect(interrupted.state).toBe('interrupted'); expect(interrupted.completedPage).toBe(1);
      await expect(page.getByText('Text extraction was stopped. Resume continues after the last saved page.', { exact: true })).toBeVisible();
      await button(page, 'Library').click();
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Unsent message while document extraction is active.');
      await button(page, 'Documents').click();
      host.checks.push('Page-one FTS result opens its exact stored page and highlighted chunk during extraction; concurrent conversation creation and unsent draft remain usable; Stop preserves page one and prevents page two.');

      await button(page, 'Resume extraction').click();
      await expect(page.getByText('Text extraction complete', { exact: true })).toBeVisible({ timeout: 90000 });
      await expect(page.getByText('Text search available through page 100.', { exact: true })).toBeVisible();
      await page.getByLabel('Page number', { exact: true }).fill('42');
      await button(page, 'Open page').click();
      await expect(page.getByRole('region', { name: 'Document page 42', exact: true })).toContainText('Quixi document fixture page 42');
      await page.screenshot({ path: resolve(results, `${name}-document-page.png`), fullPage: true });
      host.checks.push('Resume completes all100 real PDF pages; manual page navigation reads the requested original page reference with bounded extracted text.');

      await context.close(); page = await launch();
      await button(page, 'Documents').click(); await button(page, 'pages-100').click();
      await expect(page.getByText('Text extraction complete', { exact: true })).toBeVisible();
      await search(page, '"Quixi document fixture page 42"');
      await page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: 'pages-100', exact: true }).first().click();
      await expect(page.getByRole('region', { name: 'Document page 42', exact: true })).toContainText('Quixi document fixture page 42');
      host.checks.push('Full browser restart retains canonical document, completed progress, FTS and exact page-result navigation.');

      const reviewedRun = (await snapshot(page)).runs[0];
      await button(page, 'Clear saved text…').click();
      await expect(page.getByRole('region', { name: 'Clear saved document text' })).toContainText('original file stays in your archive');
      await button(page, 'Keep saved text').click();
      await expect(page.getByRole('region', { name: 'Clear saved document text' })).toHaveCount(0);
      expect((await snapshot(page)).runs[0]).toEqual(reviewedRun);
      await expect(page.getByRole('region', { name: 'Document page 42', exact: true })).toBeVisible();
      await button(page, 'Clear saved text…').click();
      await button(page, 'Clear saved text').click();
      await expect(page.getByText('Saved text and its document search entries were cleared. The original PDF is unchanged; you can extract it again.', { exact: true })).toBeVisible();
      await expect(button(page, 'Extract text')).toBeEnabled();
      const clearedRun = (await snapshot(page)).runs[0];
      expect(clearedRun.runId).toBe(reviewedRun.runId);
      expect(clearedRun.state).toBe('cleared'); expect(clearedRun.visibleRunId).toBeNull();
      expect(clearedRun.documentRevision).toBeGreaterThan(reviewedRun.documentRevision);
      await expect(page.getByRole('region', { name: 'Document page 42', exact: true })).toHaveCount(0);
      expect(await page.evaluate(id => window.documentAcceptance.verifyOriginal(id), document.id)).toBe(hash(await readFile(resolve(root, 'packages/documents/tests/fixtures/pages-100.pdf'))));
      host.checks.push('Reviewed clear can be cancelled without mutation; confirming clears the exact derived run and displayed text while preserving byte-exact original PDF.');

      // Retain the pre-clear result snapshot; clicking must validate it again.
      await button(page, 'Library').click();
      await page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: 'pages-100', exact: true }).first().click();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Document page 42', exact: true })).toHaveCount(0);
      host.checks.push('A stale search result after clearing derived extraction refuses navigation rather than showing a different/current page.');

      await page.evaluate(() => window.documentAcceptance.arm());
      await button(page, 'Extract text').click();
      await page.waitForFunction(() => window.documentAcceptance.held(), null, { timeout: 30000 });
      const restartedRun = (await snapshot(page)).runs[0];
      expect(restartedRun.runId).not.toBe(reviewedRun.runId);
      expect(restartedRun.completedPage).toBe(1);
      await button(page, 'Stop document work').click();
      await page.evaluate(() => window.documentAcceptance.release());
      await expect(button(page, 'Resume extraction')).toBeEnabled({ timeout: 30000 });
      await search(page, '"Quixi document fixture page 1"');
      await page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: 'pages-100', exact: true }).first().click();
      await expect(page.getByRole('region', { name: 'Document page 1', exact: true })).toContainText('Quixi document fixture page 1');
      host.checks.push('Explicit extraction after clear starts a different run at page one, publishes searchable text and retains normal stop/resume behavior.');

      await failedPdfRecovery('encrypted.pdf', 'password_required',
        'This PDF requires a password. Password entry is not supported yet. Import an unlocked copy to extract its text.');
      expect((await snapshot(page)).documents).toHaveLength(2);
      host.checks.push('Encrypted PDF retains its password explanation across full restart without automatic retry; explicit retry and reviewed clear preserve exact original bytes and publish no page.');
      await failedPdfRecovery('malformed.pdf', 'parser_failed',
        'Text extraction could not read this PDF. You can retry or import a repaired copy. The original file is unchanged.');
      expect((await snapshot(page)).documents).toHaveLength(3);
      host.checks.push('Malformed PDF retains its parser-failure explanation across full restart; explicit retry and reviewed clear preserve exact original bytes without invented page text.');
      const capacityMessage = 'Text extraction reached a document or storage limit. Try a smaller PDF, or free storage if your archive is full. Saved pages are retained.';
      await failedPdfRecovery('pages-1001.pdf', 'capacity', capacityMessage);
      host.checks.push('A real1001-page PDF retains its capacity outcome across full restart; retry remains bounded and reviewed clear preserves the original without publishing a page.');
      await failedPdfRecovery('dense-page.pdf', 'capacity', capacityMessage);
      host.checks.push('A real over-budget text page retains its capacity outcome across full restart; partial staging never becomes a visible page and reviewed clear preserves exact original bytes.');
      await importPdf(page, 'scanned.pdf'); await button(page, 'Extract text').click();
      await expect(page.getByText('Text extraction complete', { exact: true })).toBeVisible({ timeout: 30000 });
      await page.getByLabel('Page number', { exact: true }).fill('1'); await button(page, 'Open page').click();
      await expect(page.getByText('This page has no extractable text. It may contain scanned images.', { exact: true })).toBeVisible();
      host.checks.push('Scanned PDF displays an empty-text explanation without claiming OCR or semantic indexing.');
      await importPdf(page, 'low-text.pdf'); await button(page, 'Extract text').click();
      await expect(page.getByText('Text extraction complete', { exact: true })).toBeVisible({ timeout: 30000 });
      await page.getByLabel('Page number', { exact: true }).fill('1'); await button(page, 'Open page').click();
      const lowTextNotice = 'This page contains little useful text and may include scanned images. The extracted text is shown below.';
      await expect(page.getByText(lowTextNotice, { exact: true })).toBeVisible();
      await expect(page.locator('.document-text')).toHaveText('1');
      await context.close(); page = await launch();
      await button(page, 'Documents').click(); await button(page, 'low-text').click();
      await expect(page.getByText(lowTextNotice, { exact: true })).toBeVisible();
      await expect(page.locator('.document-text')).toHaveText('1');
      await search(page, '1');
      await page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: 'low-text', exact: true }).click();
      await expect(page.getByText(lowTextNotice, { exact: true })).toBeVisible();
      await expect(page.locator('.document-text mark')).toHaveText('1');
      host.checks.push('A scanned page with a real one-character footer retains searchable text and its low-text classification through storage, full browser restart and exact hit navigation.');
      await importPdf(page, 'layout-columns.pdf'); await button(page, 'Extract text').click();
      await expect(page.getByText('Text extraction complete', { exact: true })).toBeVisible({ timeout: 30000 });
      await search(page, '"P2-L2"');
      await page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: 'layout-columns', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Document page 2', exact: true })).toContainText('P2-L2');
      await expect(page.locator('.document-text mark')).toContainText('P2-L2');
      if (await button(page, 'Page text from start').isEnabled()) await button(page, 'Page text from start').click();
      const columnText = await page.locator('.document-text').textContent();
      const anchors = ['P2-TITLE', 'P2-L1', 'P2-L2', 'P2-R1', 'P2-R2', 'P2-FOOTER'];
      const positions = anchors.map(anchor => columnText.indexOf(anchor));
      expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]))).toBe(true);
      await importPdf(page, 'layout-table-code.pdf'); await button(page, 'Extract text').click();
      await expect(page.getByText('Text extraction complete', { exact: true })).toBeVisible({ timeout: 30000 });
      await page.getByLabel('Page number', { exact: true }).fill('1'); await button(page, 'Open page').click();
      expect(await page.locator('.document-text').textContent()).toMatch(/amber\s+7\s+warm sample/);
      await page.getByLabel('Page number', { exact: true }).fill('2'); await button(page, 'Open page').click();
      expect(await page.locator('.document-text').textContent()).toContain('  for (const value of values) {\n    sum += value;');
      host.checks.push('Actual interleaved-column PDF FTS opens page2 and its exact chunk; durable page text retains complete left-before-right reading order, table row/cell association and code indentation.');
      await importPdf(page, 'layout-unsupported.pdf'); await button(page, 'Extract text').click();
      await expect(page.getByText('Text extraction complete', { exact: true })).toBeVisible({ timeout: 30000 });
      await page.getByLabel('Page number', { exact: true }).fill('1'); await button(page, 'Open page').click();
      const layoutNotice = 'This page has an unsupported layout. Text follows the order stored in the PDF, which may differ from its visual reading order.';
      await expect(page.getByText(layoutNotice, { exact: true })).toBeVisible();
      await expect(page.locator('.document-text')).toContainText('ROTATE-90');
      await context.close(); page = await launch();
      await search(page, '"ROTATE-45"');
      await page.getByRole('region', { name: 'Search results' }).getByRole('button', { name: 'layout-unsupported', exact: true }).click();
      await expect(page.getByText(layoutNotice, { exact: true })).toBeVisible();
      await expect(page.locator('.document-text mark')).toContainText('ROTATE-45');
      host.checks.push('Mixed rotated text remains searchable with its source-order warning after full browser restart and exact search-result navigation.');
      expect(host.pageErrors).toEqual([]); expect(host.remoteRequests).toEqual([]);
      host.status = 'passed'; await save();
    } catch (error) {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: resolve(results, `${name}-failure.png`), fullPage: true }).catch(() => {});
        host.visibleText = await page.locator('body').innerText().catch(() => 'unavailable');
      }
      throw error;
    } finally { await context?.close(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; }
finally {
  report.changedSources = [];
  for (const [file, digest] of Object.entries(report.sourceSha256)) {
    const current = await readFile(resolve(root, file)).then(hash, () => null);
    if (current !== digest) report.changedSources.push(file);
  }
  report.sourceStable = report.changedSources.length === 0;
  if (!report.sourceStable && report.status === 'passed') {
    report.status = 'failed'; report.error = 'Source files changed during acceptance; preserve this capture and rerun against a stable snapshot.';
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString(); await save();
  await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve());
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
