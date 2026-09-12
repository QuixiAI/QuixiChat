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
  'packages/app/src/features/diagnostics/report-controller.ts', 'packages/app/src/features/diagnostics/DiagnosticsPanel.tsx', 'packages/app/src/features/diagnostics/export.ts', 'packages/app/src/features/diagnostics/DoctorAuditPanel.tsx', 'packages/app/src/features/diagnostics/BlobHashAuditPanel.tsx', 'packages/app/src/features/diagnostics/cleanup-controller.ts', 'packages/core/src/contracts/blob-hash-audit.ts', 'packages/storage/src/worker/blob-hash-audit.ts', 'packages/core/src/contracts/doctor-audit.ts', 'packages/storage/src/worker/doctor-audit.ts', 'packages/core/src/contracts/diagnostics.ts', 'packages/storage/src/worker/diagnostics.ts',
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
    let archiveId = null;
    const open = async (reuse = false) => {
      if (!reuse) archiveId = `test-health-${randomUUID()}`;
      await page.goto(`http://127.0.0.1:4199/?archive=${archiveId}${reuse ? '&fixture=reuse' : ''}`);
      await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled({ timeout: 30000 });
      await expect.poll(() => page.evaluate(() => !!window.storageHealthAcceptance)).toBe(true);
    };
    try {
      await open(); const baseline = await page.evaluate(() => window.storageHealthAcceptance.fixture.baseline); const digests = await page.evaluate(() => window.storageHealthAcceptance.fixture.digests);
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
      expect(await panel(page).getByRole('button').allTextContents()).toEqual(['Start a new scan', 'First findings', 'Next findings', 'Review deletion…']);
      await expect(panel(page).getByRole('button', { name: 'Review deletion…', exact: true })).toBeDisabled();
      await expect(panel(page).getByTestId('cleanup-scope')).toContainText('No files selected');
      evidence.checks.push('All seven finding categories have counts and plain-language guidance; managed identifiers reveal no synthetic private names or original content, and the only deletion control is disabled until unreferenced files are ticked');
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
      // Plan 23 diagnostics on the same seeded archive, reopened without re-seeding.
      await open(true); await page.getByRole('button', { name: 'Storage health', exact: true }).click();
      const diagnostics = page.getByRole('region', { name: 'Diagnostics', exact: true });
      const outcomes = async () => Object.fromEntries(await diagnostics.locator('[data-testid^="diagnostic-"][data-outcome]').evaluateAll(nodes => nodes.map(node => [node.dataset.testid.slice('diagnostic-'.length), node.dataset.outcome])));
      const run = async () => {
        await diagnostics.getByRole('button', { name: /Run diagnostics/ }).click();
        await expect(diagnostics.getByTestId('diagnostic-report-meta')).toBeVisible({ timeout: 30000 });
        await expect(diagnostics.getByRole('button', { name: /Run diagnostics/ })).toBeEnabled();
        return outcomes();
      };
      const seeded = await run(); const countsBefore = await page.evaluate(() => window.storageHealthAcceptance.counts());
      expect(seeded).toMatchObject({ sqlite_integrity: 'ok', schema: 'ok', fts5: 'ok', sqlite_vec: 'ok', attachment_references: 'missing_data', ownership: 'ok', lexical_index: 'ok', semantic_index: 'ok' });
      expect(['ok', 'attention', 'unknown']).toContain(seeded.persistence);
      const report = await page.evaluate(() => window.storageHealthAcceptance.report());
      expect(report.contentPolicy).toBe('operational-metadata-only'); expect(report.checks.map(check => check.id)).toEqual(['sqlite_integrity', 'schema', 'persistence', 'fts5', 'sqlite_vec', 'attachment_references', 'ownership', 'lexical_index', 'semantic_index']);
      const serialized = JSON.stringify(report).toLowerCase();
      for (const secret of ['synthetic', 'unrecognized-private-name', 'private-child', 'original bytes', '.txt']) expect(serialized).not.toContain(secret);
      const references = report.checks.find(check => check.id === 'attachment_references');
      expect(references.measured.missingFiles).toBeGreaterThanOrEqual(1); expect(references.measured.missingCatalog).toBeGreaterThanOrEqual(1);
      evidence.diagnostics = { seeded, references: references.measured, persistence: report.checks.find(check => check.id === 'persistence').measured, sqliteVersion: report.sqliteVersion, schemaVersion: report.schemaVersion };
      evidence.checks.push(`Run diagnostics reports the seeded archive: SQLite integrity, schema, FTS5, sqlite-vec, ownership and both derived indexes OK and attachment references Missing data (${references.measured.missingFiles} referenced files absent, ${references.measured.missingCatalog} without metadata among ${references.measured.references} references); the report carries no filenames, content or private names`);
      // Product §100 exportable report: the same report as one JSON file through the host save flow.
      const downloading = page.waitForEvent('download');
      await diagnostics.getByRole('button', { name: 'Save diagnostics report', exact: true }).click();
      const download = await downloading;
      const savedText = await readFile(await download.path(), 'utf8'), savedReport = JSON.parse(savedText);
      await expect(diagnostics.getByTestId('diagnostic-notice')).toContainText(/Diagnostics report saved as quixi-diagnostics-.*\.json/);
      expect(download.suggestedFilename()).toMatch(/^quixi-diagnostics-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
      expect(savedReport.format).toBe('quixi-diagnostics'); expect(savedReport.contentPolicy).toBe('operational-metadata-only'); expect(savedReport.host.kind).toBe('web');
      expect(Object.fromEntries(savedReport.storage.checks.map(check => [check.id, check.outcome]))).toEqual(seeded);
      expect(savedReport.inference).toBe(null); expect(typeof savedReport.omitted.inference).toBe('string');
      for (const secret of ['synthetic', 'unrecognized-private-name', 'private-child', 'original bytes', '.txt']) expect(savedText.toLowerCase()).not.toContain(secret);
      expect(Object.keys(savedReport).sort()).toEqual(['contentPolicy', 'format', 'host', 'inference', 'omitted', 'producedAt', 'storage', 'version']);
      evidence.savedReport = { name: download.suggestedFilename(), bytes: Buffer.byteLength(savedText), keys: Object.keys(savedReport) };
      evidence.checks.push(`Save diagnostics report writes the shown report through the host save flow as ${download.suggestedFilename()} (${Buffer.byteLength(savedText)} bytes) with only the allow-listed sections, the storage checks equal to the panel, the inference section absent with a reason, and none of the fixture's private names or content`);
      // A rebuildable derived index, told apart from corruption and repaired in place.
      await page.evaluate(() => window.storageHealthAcceptance.fault('derived-failure'));
      await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: 'Storage health', exact: true }).click();
      const broken = await run();
      expect(broken).toMatchObject({ sqlite_integrity: 'ok', schema: 'ok', lexical_index: 'rebuildable', semantic_index: 'rebuildable', attachment_references: 'missing_data' });
      await expect(diagnostics.getByTestId('diagnostic-lexical_index')).toContainText('Rebuildable derived index');
      await diagnostics.getByRole('button', { name: 'Rebuild search index', exact: true }).click();
      await expect(diagnostics.getByTestId('diagnostic-notice')).toContainText(/Search index rebuild/, { timeout: 30000 });
      await expect(diagnostics.getByRole('button', { name: 'Rebuild search index', exact: true })).toBeEnabled({ timeout: 30000 });
      const repaired = await outcomes(); expect(repaired.lexical_index).toBe('ok'); expect(repaired.semantic_index).toBe('ok');
      await expect.poll(() => page.evaluate(() => window.storageHealthAcceptance.searchStatus().then(status => status.state)), { timeout: 60000 }).toBe('ready');
      expect(await page.evaluate(() => window.storageHealthAcceptance.counts())).toEqual(countsBefore);
      evidence.diagnostics.derivedFault = broken; evidence.diagnostics.repaired = repaired;
      evidence.checks.push('A derived search-ledger fault makes the next owner report both derived indexes as Rebuildable derived index while SQLite integrity and schema stay OK; Rebuild search index repairs it from Storage health, the index returns to ready and canonical record and sync-operation counts are unchanged');
      // Semantic delete and rebuild are distinct actions; rebuild needs the model this host lacks.
      await expect(diagnostics.getByRole('button', { name: 'Rebuild semantic index', exact: true })).toBeDisabled();
      await diagnostics.getByRole('button', { name: 'Delete semantic index', exact: true }).click();
      await expect(diagnostics.getByTestId('diagnostic-notice')).toContainText('Semantic index deleted');
      await expect(diagnostics.getByRole('button', { name: 'Delete semantic index', exact: true })).toBeEnabled();
      expect((await page.evaluate(() => window.storageHealthAcceptance.semanticStatus())).state).toBe('disabled');
      evidence.checks.push('Delete semantic index and Rebuild semantic index stand beside Rebuild search index as distinct actions; delete completes with a notice and the report, and rebuild is disabled with its reason on a host without the embedding model');
      // File-level corruption, told apart from missing data and from the derived indexes.
      await page.evaluate(() => window.storageHealthAcceptance.fault('corrupt-database'));
      await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: 'Storage health', exact: true }).click();
      const corrupt = await run();
      expect(corrupt).toMatchObject({ sqlite_integrity: 'corruption', schema: 'ok', lexical_index: 'ok', attachment_references: 'missing_data' });
      await expect(diagnostics.getByTestId('diagnostic-sqlite_integrity')).toContainText('Corruption detected');
      const corruptReport = await page.evaluate(() => window.storageHealthAcceptance.report());
      evidence.diagnostics.corrupt = corruptReport.checks.find(check => check.id === 'sqlite_integrity').measured;
      evidence.checks.push(`Unreferenced b-tree pages make SQLite integrity report Corruption detected (${evidence.diagnostics.corrupt.errors} integrity messages) in the same report that keeps the schema OK, the search index OK and attachment references Missing data`);
      // Product §101 Doctor audit: clean on the seeded archive, then planted branch, provenance and sync damage found by kind.
      const audit = page.getByRole('region', { name: 'Doctor audit', exact: true });
      const auditComplete = async () => { await expect(audit.getByTestId('doctor-audit-status')).toContainText('Audit complete.', { timeout: 30000 }); };
      await audit.getByRole('button', { name: 'Start Doctor audit', exact: true }).click(); await auditComplete();
      await expect(audit.getByTestId('doctor-audit-clean')).toBeVisible();
      const cleanRecords = Number((await audit.getByTestId('doctor-audit-records').textContent()).replaceAll(',', ''));
      expect(cleanRecords).toBeGreaterThanOrEqual(4);
      expect(await audit.getByRole('button').allTextContents()).toEqual(['Start a new audit']);
      evidence.checks.push(`the Doctor audit walks ${cleanRecords} saved records and every recorded operation of the seeded archive in bounded steps and reports no branch, provenance or sync-coverage finding, with no repair or deletion control`);
      // Product §101 "verify blob hashes": the seeded archive's shortened and deleted files are found; intact bytes verify.
      const hashing = page.getByRole('region', { name: 'File content verification', exact: true });
      const hashComplete = async () => { await expect(hashing.getByTestId('hash-audit-status')).toContainText('Verification complete.', { timeout: 60000 }); };
      await hashing.getByRole('button', { name: 'Verify file contents', exact: true }).click(); await hashComplete();
      const hashCounts = async () => Object.fromEntries(await hashing.locator('.storage-health-counts div[data-kind]').evaluateAll(nodes => nodes.map(node => [node.dataset.kind, Number(node.querySelector('dd').textContent.replaceAll(',', ''))])));
      const seededHashes = await hashCounts();
      expect(seededHashes).toEqual({ size_mismatch: 1, missing_blob: 1 });
      const hashFiles = await hashing.getByTestId('hash-audit-files').textContent();
      expect(hashFiles).toMatch(/^(\d+) of \1$/);
      const hashText = await hashing.innerText();
      for (const secret of ['Synthetic', 'synthetic-', 'Original bytes']) expect(hashText).not.toContain(secret);
      expect(await hashing.getByRole('button').allTextContents()).toEqual(['Verify again', 'First findings', 'Next findings']);
      evidence.hashAudit = { seeded: seededHashes, files: hashFiles };
      evidence.checks.push(`File content verification re-reads every catalogued file (${hashFiles}) in bounded blocks: the shortened file and the deleted file are reported by digest and size, every other file's bytes match its digest, and no filename or content appears`);
      const afterDiagnostics = await page.evaluate(() => window.storageHealthAcceptance.fingerprint());
      const compared = ['canonicalSha256', 'operationsSha256', 'blobOperationsSha256', 'blobCatalogSha256', 'blobTransfersSha256', 'blobsSha256', 'canonicalRecords', 'syncOperations', 'physicalFiles'];
      for (const key of compared) expect({ key, value: afterDiagnostics[key] }).toEqual({ key, value: baseline[key] });
      evidence.afterDiagnostics = afterDiagnostics;
      evidence.checks.push('After diagnostics, the search rebuild, the semantic delete and both faults, canonical rows, sync/blob operation records, the blob catalog and transfers and every stored file byte match the baseline');
      // Planted damage (raw rows the commit path refuses) is found by kind; findings show managed ids only.
      await page.evaluate(() => window.storageHealthAcceptance.fault('doctor-faults'));
      await open(true); await page.getByRole('button', { name: 'Storage health', exact: true }).click();
      await audit.getByRole('button', { name: 'Start Doctor audit', exact: true }).click(); await auditComplete();
      const auditCounts = Object.fromEntries(await audit.locator('.storage-health-counts div[data-kind]').evaluateAll(nodes => nodes.map(node => [node.dataset.kind, Number(node.querySelector('dd').textContent.replaceAll(',', ''))])));
      expect(auditCounts).toEqual({ missing_parent: 1, part_count_mismatch: 1, missing_import_source: 1, sync_affects_missing: 1 });
      await expect(audit.getByRole('list', { name: 'Audit findings', exact: true }).getByRole('listitem')).toHaveCount(4);
      const auditText = await audit.innerText();
      for (const secret of ['Synthetic inventory notebook', 'synthetic-', 'Original bytes']) expect(auditText).not.toContain(secret);
      expect(auditText).toMatch(/messages\/[0-9a-f-]{36}/);
      expect(await audit.getByRole('button').allTextContents()).toEqual(['Start a new audit', 'First findings', 'Next findings']);
      evidence.doctorAudit = { clean: { records: cleanRecords }, planted: auditCounts };
      evidence.checks.push('after planting a message with a missing parent, a message whose part count differs from its parts, a provenance row for a missing import source and a sync operation naming a missing record, the Doctor audit reports exactly those four findings by kind with record identifiers and no titles or content, and offers no repair');
      // Same-length altered bytes are found only by hashing, and the finding names the digest that was altered.
      const corrupted = await page.evaluate(() => window.storageHealthAcceptance.fault('blob-corrupt'));
      await open(true); await page.getByRole('button', { name: 'Storage health', exact: true }).click();
      await hashing.getByRole('button', { name: 'Verify file contents', exact: true }).click(); await hashComplete();
      expect(await hashCounts()).toEqual({ hash_mismatch: 1, size_mismatch: 1, missing_blob: 1 });
      await expect(hashing.getByRole('list', { name: 'Verification findings', exact: true }).getByRole('listitem').filter({ hasText: 'File content differs from its digest' })).toContainText(corrupted.sha256);
      evidence.hashAudit.corrupted = await hashCounts();
      evidence.checks.push('after the referenced attachment file is rewritten with different bytes of the same length, verification reports it as content differing from its digest, naming that digest, beside the size and missing findings');
      // Reviewed cleanup (plan 23): explicit selection, visible scope, confirmation, worker re-check, named refusals.
      await open(true); await page.getByRole('button', { name: 'Storage health', exact: true }).click();
      await panel(page).getByRole('button', { name: 'Start storage scan', exact: true }).click(); await complete(page);
      const orphansBefore = Number((await panel(page).locator('.storage-health-counts div').filter({ hasText: 'Unreferenced stored file' }).locator('dd').textContent()).replaceAll(',', ''));
      const boxes = panel(page).getByRole('checkbox', { name: 'Select this unreferenced file for deletion' });
      expect(await boxes.count()).toBeGreaterThanOrEqual(2);
      await boxes.nth(0).check(); await boxes.nth(1).check();
      await expect(panel(page).getByTestId('cleanup-scope')).toContainText('2 unreferenced files selected');
      const selectedDigests = await panel(page).locator('.storage-health-findings li').filter({ has: page.getByRole('checkbox', { checked: true }) }).evaluateAll(nodes => nodes.map(node => node.querySelector('code').textContent));
      expect(selectedDigests).toHaveLength(2);
      await panel(page).getByRole('button', { name: 'Review deletion…', exact: true }).click();
      const review = panel(page).getByTestId('cleanup-review');
      await expect(review).toContainText('Delete 2 unreferenced files'); await expect(review).toContainText('cannot be undone');
      for (const digest of selectedDigests) await expect(review).toContainText(digest);
      await review.getByRole('button', { name: 'Keep the files', exact: true }).click(); await expect(panel(page).getByTestId('cleanup-review')).toHaveCount(0);
      const untouched = await page.evaluate(() => window.storageHealthAcceptance.counts());
      await panel(page).getByRole('button', { name: 'Review deletion…', exact: true }).click();
      await review.getByRole('button', { name: 'Delete 2 files', exact: true }).click();
      await expect(panel(page).getByTestId('cleanup-result')).toContainText('Deleted 2 unreferenced files');
      await expect(panel(page).getByRole('status').filter({ hasText: 'Storage changed' })).toBeVisible();
      const scanBefore = await page.evaluate(() => window.storageHealthAcceptance.scanId());
      const staleRefusal = await page.evaluate(([scanId, digest]) => window.storageHealthAcceptance.deleteOrphans(scanId, [digest]), [scanBefore, selectedDigests[0]]);
      expect(staleRefusal.refused.map(item => item.reason)).toEqual(['stale']); expect(staleRefusal.deleted).toEqual([]);
      await panel(page).getByRole('button', { name: 'Start a new scan', exact: true }).click(); await complete(page);
      const orphansAfter = Number((await panel(page).locator('.storage-health-counts div').filter({ hasText: 'Unreferenced stored file' }).locator('dd').textContent()).replaceAll(',', ''));
      expect(orphansAfter).toBe(orphansBefore - 2);
      const scanAfter = await page.evaluate(() => window.storageHealthAcceptance.scanId());
      const refused = await page.evaluate(([scanId, referenced, protectedDigest]) => window.storageHealthAcceptance.deleteOrphans(scanId, [referenced, protectedDigest, 'f'.repeat(64)]), [scanAfter, digests.attachment, digests.publishedProtected]);
      expect(refused.deleted).toEqual([]); expect(refused.refused.map(item => item.reason)).toEqual(['not_a_finding', 'not_a_finding', 'not_a_finding']);
      expect((await page.evaluate(() => window.storageHealthAcceptance.counts()))).toEqual(untouched);
      evidence.cleanup = { orphansBefore, orphansAfter, deleted: selectedDigests, refusals: refused.refused.map(item => item.reason) };
      evidence.checks.push(`Reviewed cleanup: two ticked unreferenced files are shown with their digests and total size before a separate confirmation; Keep the files changes nothing; confirming deletes exactly those two (orphan count ${orphansBefore} → ${orphansAfter}), the scan reads stale until a new one, a stale scan refuses further deletion, and a referenced file, an import-protected file and an unknown digest are each refused as not a finding of the scan with canonical counts unchanged`);
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
