import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const engines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, '../../../../..'), temporary = await mkdtemp(resolve(tmpdir(), 'quixi-reconcile-integration-'));
const report = { status: 'running', selectedEngines: engines.map(([name]) => name), startedAt: new Date().toISOString(), environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : release(), node: process.version }, sourceSha256: {}, hosts: [] };
const output = resolve(root, 'test-results/production-reconcile-browser.json');
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
    'packages/storage/tests/selection/integration/reconcile.mjs', 'tooling/browser-engines.mjs',
  ]) report.sourceSha256[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
  for (const [name, engine] of engines) {
    const host = { name, status: 'running', checks: [], refusals: [] }; report.hosts.push(host); await save();
    const profile = resolve(temporary, name); let context = await engine.launchPersistentContext(profile, { headless: true });
    const visit = async () => { const page = await context.newPage(); await page.goto(baseURL); await page.waitForFunction(() => !!window.activationTest); return page; };
    try {
      const source = await visit(), active = await visit();
      host.userAgent = await source.evaluate(() => navigator.userAgent);
      host.initialOpfs = await source.evaluate(async () => { const entries = []; for await (const entry of (await navigator.storage.getDirectory()).values()) entries.push(entry.name); return entries.sort(); });
      expect(host.initialOpfs).toEqual([]);
      const original = await call(source, 'open');
      await call(source, 'seed');
      const copied = await call(source, 'copy');
      const first = await call(source, 'write', 'Retained source only: first committed operation');
      const second = await call(source, 'write', 'Retained source only: second committed operation');
      const review = await call(source, 'review', copied.job.jobId);
      const receipt = await call(source, 'activate', review);
      expect(receipt.selected.archiveId).not.toBe(original.selection.archiveId);
      await call(source, 'close');
      expect((await call(active, 'open')).selection).toEqual(receipt.selected);
      expect(await call(active, 'readThread', first.threadId)).toBeNull();
      expect(await call(active, 'readThread', second.threadId)).toBeNull();

      const stillSelected = await rejected(active, 'reconcileActive', [[first.operationId]]);
      expect(stillSelected.message).toMatch(/still selected/);
      const allowed = await call(active, 'write', 'Selected client remains usable after refusal');
      expect(await call(active, 'readThread', allowed.threadId)).not.toBeNull();
      host.checks.push('currently selected client refuses retained reconciliation without closing; a subsequent real canonical write and read succeed');

      const selectedBefore = await call(active, 'diagnostics');
      const sourceBefore = await call(active, 'retainedSync', original.selection.archiveId);
      const known = [first.operationId, second.operationId], missing = [randomUUID(), randomUUID()];
      const receiptsBefore = [];
      for (const operationId of known) receiptsBefore.push(await call(active, 'retainedStatus', original.selection.archiveId, operationId));
      expect(receiptsBefore.every(result => result.status === 'committed')).toBe(true);
      expect(await call(source, 'reconcilePrevious', known)).toBe('committed');
      expect(await call(source, 'reconcilePrevious', missing)).toBe('not_committed');
      const mixed = await rejected(source, 'reconcilePrevious', [[known[0], missing[0]]]);
      expect(mixed.message).toMatch(/inconsistent retained receipts/);
      for (const invalid of [[], [known[0], known[0]], ['not-a-uuid']]) {
        expect((await rejected(source, 'reconcilePrevious', [invalid])).message).toMatch(/Invalid pending canonical operation identities/);
      }
      const selectedAfter = await call(active, 'diagnostics');
      expect(selectedAfter.canonicalRecords).toBe(selectedBefore.canonicalRecords);
      expect(selectedAfter.syncOperations).toBe(selectedBefore.syncOperations);
      expect(await call(active, 'retainedSync', original.selection.archiveId)).toEqual(sourceBefore);
      for (let n = 0; n < known.length; n++) expect(await call(active, 'retainedStatus', original.selection.archiveId, known[n])).toEqual(receiptsBefore[n]);
      for (const operationId of missing) expect((await call(active, 'retainedStatus', original.selection.archiveId, operationId)).status).toBe('not_found');
      expect(await call(active, 'readThread', first.threadId)).toBeNull();
      expect(await call(active, 'readThread', second.threadId)).toBeNull();
      host.counts = { selectedCanonical: selectedAfter.canonicalRecords, selectedSync: selectedAfter.syncOperations, retainedHighWater: sourceBefore.highWaterSequence };
      host.checks.push('closed original client resolves all committed and all absent source operation IDs, rejects mixed/invalid sets, preserves exact source receipts and sync page, and never replays or retargets selected canonical writes');
      await call(active, 'close');
    } finally { await context.close(); }
    host.status = 'passed'; await save(); console.log(`${name}: production retained reconciliation passed ${host.checks.length} checks`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
