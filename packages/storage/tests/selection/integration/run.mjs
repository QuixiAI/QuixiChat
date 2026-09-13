import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const engines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, '../../../../..'), temporary = await mkdtemp(resolve(tmpdir(), 'quixi-activation-integration-'));
const report = { status: 'running', selectedEngines: engines.map(([name]) => name), startedAt: new Date().toISOString(), environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : release(), node: process.version }, sourceSha256: {}, hosts: [] };
const output = resolve(root, 'test-results/production-activation-browser.json');
const save = async () => { await mkdir(resolve(root, 'test-results'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
const invoke = (page, method, ...args) => page.evaluate(async ({ method, args }) => {
  try { return { ok: true, result: await window.activationTest[method](...args) }; }
  catch (error) { return { ok: false, error: { code: error?.code, message: String(error), detail: error?.detail } }; }
}, { method, args });
const call = async (...args) => { const value = await invoke(...args); if (!value.ok) throw new Error(JSON.stringify(value.error)); return value.result; };
const rejected = async (page, method, args, code) => { const value = await invoke(page, method, ...args); expect(value.ok).toBe(false); if (code) expect(value.error.code).toBe(code); return value.error; };
let server;
try {
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  server = await preview({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated test server address');
  const baseURL = `http://127.0.0.1:${address.port}`;
  report.origin = baseURL;
  for (const file of [
    'packages/storage/src/client/archive.ts', 'packages/storage/src/client/selection.ts',
    'packages/storage/src/client/reconcile-retained.ts', 'packages/storage/src/client/retained-archive.ts', 'packages/storage/src/worker/retained-archive.ts',
    'packages/storage/src/archive-protocol.ts', 'packages/storage/src/worker/archive.ts',
    'packages/storage/src/worker/archive-runtime.ts', 'packages/storage/src/worker/archive-database.ts',
    'packages/storage/src/worker/selection.ts', 'packages/storage/src/worker/sqlite-module.ts',
    'packages/storage/src/selection/managed-catalog.ts', 'packages/storage/src/worker/archives/index.ts',
    'packages/storage/migrations/index.ts', 'packages/core/src/contracts/selection.ts',
    'packages/core/src/contracts/archives.ts', 'packages/storage/tests/selection/integration/index.ts',
    'packages/storage/tests/selection/integration/run.mjs', 'tooling/browser-engines.mjs',
  ]) report.sourceSha256[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
  for (const [name, engine] of engines) {
    const host = { name, status: 'running', checks: [], refusals: [] }; report.hosts.push(host); await save();
    const profile = resolve(temporary, name); let context = await engine.launchPersistentContext(profile, { headless: true });
    const visit = async () => { const page = await context.newPage(); await page.goto(baseURL); await page.waitForFunction(() => !!window.activationTest); return page; };
    let fixture, review, receipt, exportedDiagnostics, followerThread, laterThread;
    try {
      const owner = await visit(), follower = await visit(); host.userAgent = await owner.evaluate(() => navigator.userAgent);
      host.initialOpfs = await owner.evaluate(async () => { const entries = []; for await (const entry of (await navigator.storage.getDirectory()).values()) entries.push(entry.name); return entries.sort(); });
      await save();
      expect(host.initialOpfs, 'Fresh origin must be empty; never clear or adopt another run’s stored archives').toEqual([]);
      const opened = await call(owner, 'open'), followed = await call(follower, 'open');
      expect(opened.selection).toEqual({ archiveId: 'default', selectionRevision: 0 });
      expect(followed.selection).toEqual(opened.selection); expect(followed.diagnostics.ownerId).toBe(opened.diagnostics.ownerId);
      expect(opened.diagnostics.schemaVersion).toBe(13);
      fixture = await call(follower, 'seed'); followerThread = await call(follower, 'write', 'Follower committed before portable snapshot');
      await call(owner, 'verify', fixture);
      await call(follower, 'close'); await call(owner, 'close');
      const reopened = await call(owner, 'open'); await call(follower, 'open'); expect(reopened.selection).toEqual(opened.selection);
      exportedDiagnostics = await call(owner, 'verify', fixture);
      host.checks.push('actual default bootstrap/schema12 and public managed owner/follower commits survive complete client closure and reopen'); await save();

      host.copy = await call(owner, 'copy');
      expect(host.copy.peakChunkBytes).toBeLessThanOrEqual(65536); expect(host.copy.byteLength).toBeGreaterThan(2 * 1048576);
      expect(host.copy.job.candidate.archiveId).not.toBe('default'); expect(await call(owner, 'selection')).toEqual(opened.selection);
      review = await call(owner, 'review', host.copy.job.jobId);
      expect(review.review.expectedRevision).toBe((await call(owner, 'context')).expectedRevision);
      host.checks.push('portable export and real bounded restore produce schema12 isolated candidate; review preparation does not change active selection'); await save();

      const forged = structuredClone(review); forged.operationId = randomUUID(); forged.review.candidate.canonicalRecords++;
      host.refusals.push(await rejected(owner, 'activate', [forged], 'CONFLICT'));
      expect((await call(owner, 'status', forged)).status).toBe('failed'); expect(await call(owner, 'selection')).toEqual(opened.selection);
      laterThread = await call(follower, 'write', 'Source changed after review');
      host.refusals.push(await rejected(owner, 'activate', [review], 'CONFLICT'));
      expect((await call(owner, 'status', review)).status).toBe('failed'); expect(await call(owner, 'selection')).toEqual(opened.selection);
      expect(await call(owner, 'readThread', laterThread.threadId)).not.toBeNull();
      host.checks.push('forged full candidate summary and changed source sync high-water refuse real activation and preserve active source'); await save();

      await call(follower, 'live', fixture); review = await call(owner, 'review', host.copy.job.jobId);
      host.refusals.push(await rejected(owner, 'activate', [review], 'CONFLICT'));
      expect(await call(owner, 'selection')).toEqual(opened.selection);
      await call(follower, 'stop'); review = await call(owner, 'review', host.copy.job.jobId);
      host.checks.push('positively live registered generation prevents activation; explicit partial completion and producer release permit a fresh review'); await save();

      const activationOutcome = await invoke(owner, 'activate', review, true);
      expect(await call(owner, 'suppressed')).toBe(1);
      expect(activationOutcome.ok).toBe(false); host.lostReply = activationOutcome.error;
      expect(host.lostReply.code).toBe('UNKNOWN_OUTCOME');
      expect(host.lostReply.detail.operationId).toBe(review.operationId);
      expect(host.lostReply.detail.retry).toBe('same_operation_id');
      const committed = await call(follower, 'status', review); expect(committed.status).toBe('committed'); receipt = committed.receipt;
      expect(receipt.previous).toEqual(opened.selection);
      expect(receipt.selected).toEqual({ archiveId: host.copy.job.candidate.archiveId, selectionRevision: 1 });
      expect(receipt.review).toEqual(review.review);
      host.refusals.push(await rejected(follower, 'write', ['Stale source writer must not commit'], 'CONFLICT'));
      const active = await visit(); expect((await call(active, 'open')).selection).toEqual(receipt.selected);
      const selectedDiagnostics = await call(active, 'verify', fixture);
      expect(selectedDiagnostics.canonicalRecords).toBe(exportedDiagnostics.canonicalRecords);
      expect(selectedDiagnostics.syncOperations).toBe(exportedDiagnostics.syncOperations);
      expect(await call(active, 'readThread', followerThread.threadId)).not.toBeNull();
      expect(await call(active, 'readThread', laterThread.threadId)).toBeNull();
      host.checks.push('lost real activation reply resolves through global committed receipt; stale follower writes fail; actual candidate opens with exact snapshot history, NUL/Unicode text and 2MiB original bytes'); await save();

      await call(owner, 'close'); await call(follower, 'close');
      expect((await call(active, 'status', review)).receipt).toEqual(receipt);
      expect(await call(active, 'exists', 'quixi')).toBe(true);
      expect(await call(active, 'retainedThread', receipt.previous.archiveId, laterThread.threadId)).not.toBeNull();
      expect((await call(active, 'retainedSync', receipt.previous.archiveId)).highWaterSequence).toBe(review.review.expectedRevision);
      await call(active, 'close');
      host.checks.push('global same-ID receipt and public read-only retained source rows/sync history remain available after source clients close; selected snapshot excludes the later source thread'); await save();
    } finally { await context.close(); }
    context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await visit(); expect(await call(page, 'selection')).toEqual(receipt.selected);
      expect((await call(page, 'status', review)).receipt).toEqual(receipt);
      expect((await call(page, 'open')).selection).toEqual(receipt.selected);
      const diagnostics = await call(page, 'verify', fixture); expect(diagnostics.syncOperations).toBe(exportedDiagnostics.syncOperations);
      await call(page, 'close');
      host.checks.push('complete persistent browser-process restart preserves selected candidate, exact canonical/blob history and global activation receipt'); await save();

      await call(page, 'removeSelectedNamespace', receipt.selected.archiveId);
      await rejected(page, 'selection', []);
      await rejected(page, 'open', []);
      expect((await call(page, 'status', review)).receipt).toEqual(receipt);
      expect(await call(page, 'exists', `quixi-${receipt.selected.archiveId}`)).toBe(false);
      expect(await call(page, 'retainedThread', receipt.previous.archiveId, laterThread.threadId)).not.toBeNull();
      host.checks.push('deleting selected archive namespace blocks selection/open but global committed receipt remains inspectable without fallback or recreation'); await save();

      await call(page, 'removeCatalog'); expect(await call(page, 'exists', 'quixi-selection')).toBe(false);
      host.catalogLoss = await rejected(page, 'selection', []);
      expect(host.catalogLoss.message).toMatch(/selection|bootstrap|recovery/i);
      expect(await call(page, 'exists', 'quixi-selection')).toBe(false);
      expect(await call(page, 'exists', 'quixi')).toBe(true);
      expect(await call(page, 'exists', `quixi-${receipt.selected.archiveId}`)).toBe(false);
      expect((await call(page, 'retainedSync', receipt.previous.archiveId)).highWaterSequence).toBe(review.review.expectedRevision);
      host.checks.push('subsequent whole catalog-root loss with surviving default bootstrap marker fails instead of selecting default or recreating the deliberately deleted candidate; retained default survives');
    } finally { await context.close(); }
    host.status = 'passed'; await save(); console.log(`${name}: production archive activation passed ${host.checks.length} checks`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
