import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform, release, arch } from 'node:os';
import { resolve } from 'node:path';
const selected = browserEngines({ chromium, webkit });
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-blob-inventory-proof-'));
const output = 'test-results/blob-inventory-browser.json';
const report = { status: 'running', startedAt: new Date().toISOString(), selectedEngines: selected.map(([name]) => name), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, scope: 'Actual isolated canonical SQLite/OPFS and production archive-worker/client inventory API. Impossible byte/catalog states are seeded only by a separate fixture worker. No deletion, repair, hash verification, physical disk corruption recovery, native host or private archive claim.', sourceSha256: {}, hosts: [] };
const save = async () => { await mkdir('test-results', { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
const invoke = (page, method, ...args) => page.evaluate(async ({ method, args }) => { try { return { ok: true, result: await window.blobInventoryProof[method](...args) }; } catch (error) { return { ok: false, error: { code: error?.code, message: String(error) } }; } }, { method, args });
const call = async (...args) => { const result = await invoke(...args); if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.result; };
const request = (page, operation, args) => call(page, 'request', operation, args);
const rejected = async (page, operation, args, code) => { const value = await invoke(page, 'request', operation, args); expect(value.ok).toBe(false); if (code) expect(value.error.code).toBe(code); return value.error; };
let server;
try {
  for (const source of [
    'packages/core/src/contracts/blob-inventory.ts', 'packages/core/src/contracts/storage.ts', 'packages/core/src/contracts/index.ts',
    'packages/storage/src/worker/blob-inventory.ts', 'packages/storage/src/worker/blobs.ts', 'packages/storage/src/worker/blob-catalog.ts',
    'packages/storage/src/worker/archive-database.ts', 'packages/storage/src/worker/archive-runtime.ts', 'packages/storage/src/client/archive.ts', 'packages/storage/src/archive-protocol.ts',
    'packages/storage/src/worker/canonical/repository.ts', 'packages/storage/src/worker/canonical/imports.ts', 'packages/storage/src/worker/sqlite-module.ts', 'packages/storage/migrations/index.ts',
    'packages/storage/tests/isolated-worker.ts', 'packages/storage/tests/isolated-client.ts',
    'packages/storage/tests/blob-inventory/fixture.ts', 'packages/storage/tests/blob-inventory/fixture-worker.ts', 'packages/storage/tests/blob-inventory/index.ts', 'packages/storage/tests/blob-inventory/index.html', 'packages/storage/tests/blob-inventory/tsconfig.json', 'packages/storage/tests/blob-inventory/run.mjs',
    'packages/storage/sqlite/dist/sqlite3.mjs', 'packages/storage/sqlite/dist/sqlite3.wasm', 'tooling/browser-engines.mjs', 'package.json', 'package-lock.json', '.github/workflows/check.yml',
  ]) report.sourceSha256[source] = createHash('sha256').update(await readFile(source)).digest('hex');
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, worker: { format: 'es' }, build: { outDir, emptyOutDir: true }, logLevel: 'warn' });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: '127.0.0.1', port: 4205, strictPort: true }, logLevel: 'warn' });
  for (const [name, engine] of selected) {
    const evidence = { name, status: 'running', checks: [], slices: [], pageSizes: [] }; report.hosts.push(evidence);
    const profile = resolve(temporary, name), archiveId = 'test-inventory-' + randomUUID();
    let context = await engine.launchPersistentContext(profile, { headless: true });
    let page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto('http://127.0.0.1:4205');
      const fixture = await call(page, 'setup', archiveId, 96); evidence.fixture = fixture;
      expect(fixture.baseline.sqliteTemporaryStore).toBe(1); expect(fixture.baseline.sqliteTemporaryCacheKiB).toBe(-1024);
      await call(page, 'open', archiveId);
      const readOnly = await request(page, 'readBlobTransfer', { sha256: fixture.digests.attachment });
      const scanId = randomUUID(); let status = await request(page, 'beginBlobInventory', { scanId });
      expect(status.state).toBe('running');
      await rejected(page, 'beginBlobInventory', { scanId: randomUUID() }, 'CONFLICT');
      await request(page, 'discardBlobTransfer', { transferId: readOnly.transferId });
      expect((await request(page, 'blobInventoryStatus', { scanId })).state).toBe('running');
      const ticksBefore = await call(page, 'ticks');
      for (let step = 0; status.state === 'running' && step < 256; step++) {
        const started = performance.now(), previous = status;
        status = await request(page, 'advanceBlobInventory', { scanId, maxItems: 7 });
        evidence.slices.push({ phase: status.phase, elapsedMs: performance.now() - started, records: status.scannedRecords - previous.scannedRecords, transfers: status.scannedTransfers - previous.scannedTransfers, catalog: status.scannedCatalogEntries - previous.scannedCatalogEntries, files: status.scannedFiles - previous.scannedFiles });
        const slice = evidence.slices.at(-1); expect(slice.records + slice.transfers + slice.catalog + slice.files).toBeLessThanOrEqual(7);
      }
      expect(status.state).toBe('complete'); expect(evidence.slices.length).toBeGreaterThan(20);
      expect(await call(page, 'ticks')).toBeGreaterThan(ticksBefore);
      const findings = []; let cursor = null, firstCursor = null;
      for (let index = 0; index < 128; index++) {
        const result = await request(page, 'readBlobInventoryFindings', { scanId, page: { maxItems: 5, maxBytes: 2048, cursor } });
        expect(result.items.length).toBeLessThanOrEqual(5); expect(result.bytes).toBeLessThanOrEqual(2048); expect(Buffer.byteLength(JSON.stringify(result.items))).toBe(result.bytes);
        evidence.pageSizes.push({ items: result.items.length, bytes: result.bytes }); findings.push(...result.items);
        cursor = result.nextCursor; firstCursor ??= cursor; if (!cursor) break;
      }
      expect(cursor).toBeNull(); expect(findings.length).toBeGreaterThan(96); expect(new Set(findings.map(item => item.sequence)).size).toBe(findings.length);
      const kinds = ['missing_blob', 'missing_catalog', 'orphan_blob', 'size_mismatch', 'protected_blob', 'staged_file', 'unrecognized_entry'];
      for (const kind of kinds) { expect(findings.some(item => item.kind === kind)).toBe(true); expect(findings.filter(item => item.kind === kind).length).toBe(status.counts[kind]); }
      const byteLimitedPage = await request(page, 'readBlobInventoryFindings', { scanId, page: { maxItems: 64, maxBytes: 1024, cursor: null } });
      expect(byteLimitedPage.items.length).toBeLessThan(64); expect(byteLimitedPage.bytes).toBeLessThanOrEqual(1024); expect(byteLimitedPage.nextCursor).not.toBeNull(); evidence.byteLimitedPage = { items: byteLimitedPage.items.length, bytes: byteLimitedPage.bytes };
      const finding = (kind, digest) => findings.find(item => item.kind === kind && item.sha256 === digest);
      expect(finding('missing_blob', fixture.digests.missing)).toBeTruthy(); expect(finding('missing_catalog', fixture.digests.catalogMissing)).toBeTruthy(); expect(finding('size_mismatch', fixture.digests.wrongSize)).toMatchObject({ actualBytes: 5 });
      expect(finding('orphan_blob', fixture.digests.registeredOrphan)).toBeTruthy(); expect(finding('orphan_blob', fixture.digests.physicalOrphan)).toBeTruthy();
      for (const digest of [fixture.digests.publishedProtected, fixture.digests.verifiedProtected, fixture.digests.importProtected]) { expect(finding('protected_blob', digest)).toBeTruthy(); expect(finding('orphan_blob', digest)).toBeUndefined(); }
      for (const digest of [fixture.digests.attachment, fixture.digests.raw, fixture.digests.text]) expect(findings.some(item => item.sha256 === digest && item.kind !== 'protected_blob')).toBe(false);
      expect(JSON.stringify(findings)).not.toContain('private-name'); expect(JSON.stringify(findings)).not.toContain('private-child'); expect(JSON.stringify(findings)).not.toContain('Synthetic');
      evidence.statusAfterScan = status; evidence.findings = findings;
      evidence.checks.push('actual canonical attachment, raw-object and text-blob references distinguish all seven finding kinds while active import/verified/published descriptors protect recoverable bytes', 'real multi-slice SQLite/OPFS traversal and bounded cursor pages finish without blocking main-thread timers or returning uploaded names/content');
      evidence.checks.push('a competing scan cannot replace active work, and closing a verified read-only transfer does not falsely invalidate the inventory');
      await rejected(page, 'advanceBlobInventory', { scanId, maxItems: 65 }, 'INVALID_REQUEST');
      await rejected(page, 'readBlobInventoryFindings', { scanId, page: { maxItems: 65, maxBytes: 2048, cursor: null } }, 'INVALID_REQUEST');
      await rejected(page, 'readBlobInventoryFindings', { scanId, page: { maxItems: 5, maxBytes: 2048, cursor: 'not-an-inventory-cursor' } });
      const cancelId = randomUUID(); await request(page, 'beginBlobInventory', { scanId: cancelId }); await request(page, 'advanceBlobInventory', { scanId: cancelId, maxItems: 1 });
      const cancelled = await request(page, 'cancelBlobInventory', { scanId: cancelId }); expect(cancelled.state).toBe('cancelled');
      const afterCancel = await request(page, 'blobInventoryStatus', { scanId: cancelId }); expect(afterCancel).toEqual(cancelled);
      const preparingPage = await request(page, 'readBlobInventoryFindings', { scanId: cancelId, page: { maxItems: 5, maxBytes: 2048, cursor: null } }); expect(preparingPage.items).toEqual([]);
      evidence.checks.push('oversized work/pages and invalid or foreign cursors are refused; explicit cancellation preserves the bounded partial scan');
      await call(page, 'close'); const preserved = await call(page, 'fingerprint', archiveId); expect(preserved).toEqual(fixture.baseline); evidence.preserved = preserved;
      evidence.checks.push('complete/cancelled inventory leaves canonical records, sync operations, blob operations, catalog availability/size fields, durable transfer rows and every original/staged/unrecognized physical file hash unchanged');
      await call(page, 'open', archiveId); await rejected(page, 'blobInventoryStatus', { scanId: cancelId }, 'NOT_FOUND');
      const staleId = randomUUID(); await request(page, 'beginBlobInventory', { scanId: staleId }); await request(page, 'advanceBlobInventory', { scanId: staleId, maxItems: 1 });
      await call(page, 'mutateTitle', fixture.threadId);
      const stale = await request(page, 'advanceBlobInventory', { scanId: staleId, maxItems: 7 }); expect(stale.state).toBe('stale');
      evidence.checks.push('owner restart invalidates owner-local scan identities; a canonical mutation between slices marks the old scan stale');
      const active = await call(page, 'activeTransfer');
      const activeId = randomUUID(); let activeStatus = await request(page, 'beginBlobInventory', { scanId: activeId });
      for (let index = 0; activeStatus.state === 'running' && index < 128; index++) activeStatus = await request(page, 'advanceBlobInventory', { scanId: activeId, maxItems: 64 });
      expect(activeStatus.state).toBe('complete');
      if (firstCursor) await rejected(page, 'readBlobInventoryFindings', { scanId: activeId, page: { maxItems: 5, maxBytes: 2048, cursor: firstCursor } }, 'INVALID_REQUEST');
      const activeFindings = []; cursor = null;
      do { const result = await request(page, 'readBlobInventoryFindings', { scanId: activeId, page: { maxItems: 64, maxBytes: 65536, cursor } }); activeFindings.push(...result.items); cursor = result.nextCursor; } while (cursor);
      expect(activeFindings.some(item => item.path?.includes(active.transferId) && ['protected_blob', 'staged_file'].includes(item.kind))).toBe(true);
      evidence.activeTransferId = active.transferId; evidence.activeStatus = activeStatus;
      evidence.checks.push('an actual unfinished upload remains protected/staged during inventory and is never reported as an orphan');
      await call(page, 'appendActiveTransfer', active.transferId);
      expect((await request(page, 'blobInventoryStatus', { scanId: activeId })).state).toBe('stale');
      evidence.checks.push('appending bytes to a live production upload invalidates an already complete inventory snapshot without any canonical mutation');
      const completedId = randomUUID(); let completed = await request(page, 'beginBlobInventory', { scanId: completedId });
      for (let index = 0; completed.state === 'running' && index < 128; index++) completed = await request(page, 'advanceBlobInventory', { scanId: completedId, maxItems: 64 });
      expect(completed.state).toBe('complete'); await call(page, 'mutateTitle', fixture.threadId);
      expect((await request(page, 'blobInventoryStatus', { scanId: completedId })).state).toBe('stale');
      evidence.checks.push('a canonical commit invalidates an already complete snapshot; scratch tables remain file-backed with an explicit one-MiB cache');
      await call(page, 'close'); const beforeRestart = await call(page, 'fingerprint', archiveId); evidence.beforeRestart = beforeRestart;
      await context.close(); context = await engine.launchPersistentContext(profile, { headless: true }); page = await context.newPage(); await page.goto('http://127.0.0.1:4205');
      await call(page, 'open', archiveId); await rejected(page, 'blobInventoryStatus', { scanId: activeId }, 'NOT_FOUND'); await call(page, 'close');
      const restarted = await call(page, 'fingerprint', archiveId); expect(restarted).toEqual(beforeRestart); expect(restarted.canonicalRecords).toBe(fixture.baseline.canonicalRecords); expect(restarted.syncOperations).toBe(fixture.baseline.syncOperations + 2);
      evidence.restarted = restarted; evidence.checks.push('fresh browser process preserves exact canonical/file fingerprints and the two intentional mutations while discarding transient inventory ownership');
      const malformedBaseline = await call(page, 'corruptReference', archiveId); await call(page, 'open', archiveId);
      const malformedId = randomUUID(); let malformed = await request(page, 'beginBlobInventory', { scanId: malformedId });
      for (let index = 0; malformed.state === 'running' && index < 128; index++) malformed = await request(page, 'advanceBlobInventory', { scanId: malformedId, maxItems: 64 });
      expect(malformed.state).toBe('failed'); expect(malformed.counts.orphan_blob).toBe(0); evidence.malformedStatus = malformed;
      await call(page, 'close'); expect(await call(page, 'fingerprint', archiveId)).toEqual(malformedBaseline);
      evidence.checks.push('a deliberately malformed available canonical reference fails the scan before orphan classification and preserves the corrupt input for recovery');
      await call(page, 'cleanup', archiveId); expect(errors).toEqual([]); evidence.status = 'passed'; console.log(`${name}: ${evidence.checks.length} blob inventory checks passed`);
    } catch (error) { evidence.status = 'failed'; throw error; }
    finally { await context.close(); }
    await save();
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; }
finally {
  report.changedSources = [];
  for (const [source, hash] of Object.entries(report.sourceSha256)) if (createHash('sha256').update(await readFile(source)).digest('hex') !== hash) report.changedSources.push(source);
  if (report.changedSources.length) { report.status = 'failed'; process.exitCode = 1; }
  report.completedAt = new Date().toISOString(); await save(); await server?.httpServer.close(); await rm(temporary, { recursive: true, force: true });
  await mkdir('test-results/blob-inventory-attempts', { recursive: true });
  await writeFile(`test-results/blob-inventory-attempts/${report.startedAt.replaceAll(':', '-')}-${randomUUID()}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, hosts: report.hosts.map(host => ({ name: host.name, status: host.status, checks: host.checks.length })), error: report.error ?? null }, null, 2));
}
