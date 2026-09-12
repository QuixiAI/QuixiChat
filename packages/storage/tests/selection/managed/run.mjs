import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID as id } from 'node:crypto';
const engines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, '../../../../..'), temporary = await mkdtemp(resolve(tmpdir(), 'quixi-managed-selection-'));
const report = { status: 'running', selectedEngines: engines.map(([name]) => name), startedAt: new Date().toISOString(), environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : release(), node: process.version }, sourceSha256: {}, hosts: [] };
const save = async () => { await mkdir(resolve(root, 'test-results'), { recursive: true }); await writeFile(resolve(root, 'test-results/managed-selection-browser.json'), JSON.stringify(report, null, 2) + '\n'); };
const rpc = (page, name, command, args = {}) => page.evaluate(async ({ name, command, args }) => {
  try { return { ok: true, result: await window.managedProof.call(name, command, args) }; }
  catch (error) { return { ok: false, error }; }
}, { name, command, args });
const call = async (...args) => { const result = await rpc(...args); if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.result; };
const rejected = async (page, name, command, args, code) => { const value = await rpc(page, name, command, args); expect(value.ok).toBe(false); if (code) expect(value.error.code).toBe(code); return value.error; };
const create = (page, name) => page.evaluate(name => window.managedProof.create(name), name);
const start = (page, name, command, args, key) => page.evaluate(value => window.managedProof.start(value.name, value.command, value.args, value.key), { name, command, args, key });
const phase = (page, name, event) => page.waitForFunction(({ name, event }) => window.managedProof.events(name).some(item => item.event === event), { name, event }, { timeout: 15_000 });
const activation = expected => ({ operationId: id(), expectedSelection: expected, review: { token: id(), jobId: id(), expectedActiveArchiveId: expected.archiveId, expectedRevision: 10, candidate: { archiveId: id(), schemaVersion: 9, canonicalRecords: 4, syncOperations: 1, blobCount: 0, blobBytes: 0, streamingGenerations: 0, defaultWorkspaceId: null, manifestSha256: 'a'.repeat(64) } } });
const candidate = (page, name, value) => call(page, name, 'candidate', { archiveId: value.review.candidate.archiveId });
let server;
try {
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  server = await preview({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: 4203, strictPort: true } });
  for (const file of ['packages/storage/src/selection/managed-catalog.ts', 'packages/storage/src/worker/sqlite-module.ts', 'packages/storage/tests/selection/managed/index.mjs', 'packages/storage/tests/selection/managed/worker.ts', 'packages/storage/tests/selection/managed/run.mjs', 'tooling/browser-engines.mjs']) report.sourceSha256[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
  for (const [name, engine] of engines) {
    const host = { name, status: 'running', checks: [] }; report.hosts.push(host); await save();
    const profile = resolve(temporary, name), namespace = `test-managed-${id()}`;
    let context = await engine.launchPersistentContext(profile, { headless: true });
    const visit = async () => { const page = await context.newPage(); await page.goto('http://127.0.0.1:4203/'); await page.waitForFunction(() => !!window.managedProof); return page; };
    let last, prior, pending;
    try {
      const page = await visit(); host.userAgent = await page.evaluate(() => navigator.userAgent);
      await create(page, 'a'); await create(page, 'b');
      const absent = `test-no-init-${id()}`;
      await rejected(page, 'a', 'open', { namespace: absent, noInitializer: true }, 'UNAVAILABLE');
      expect(await call(page, 'a', 'exists', { namespace: absent })).toBe(false);
      await rejected(page, 'a', 'open', { namespace: absent, failInitialize: true }, 'UNAVAILABLE');
      expect(await call(page, 'a', 'exists', { namespace: absent })).toBe(false);
      await start(page, 'b', 'holdDefault', {}, 'held-default'); await phase(page, 'b', 'default-held');
      await rejected(page, 'a', 'open', { namespace: absent }, 'UNAVAILABLE');
      expect(await call(page, 'a', 'exists', { namespace: absent })).toBe(false);
      await call(page, 'b', 'release');
      expect(await call(page, 'a', 'open', { namespace })).toEqual({ archiveId: 'default', selectionRevision: 0 });
      const initCount = await call(page, 'a', 'initializations'); await call(page, 'a', 'read'); expect(await call(page, 'a', 'initializations')).toBe(initCount);
      await call(page, 'b', 'open', { namespace, noInitializer: true });
      expect(await call(page, 'a', 'admission')).toBe(true);
      host.checks.push('first bootstrap requires actual canonical default creation under nonwaiting owner admission; failures create no catalog, existing catalog never reinitializes; singleton module and 16-call admission');

      const expected = await call(page, 'a', 'read'), first = activation(expected), other = activation(expected);
      await candidate(page, 'a', first); await candidate(page, 'b', other);
      const raced = await Promise.all([rpc(page, 'a', 'activate', { activation: first }), rpc(page, 'b', 'activate', { activation: other })]);
      expect(raced.filter(result => result.ok)).toHaveLength(1);
      prior = raced[0].ok ? first : other; last = await call(page, 'a', 'read');
      expect(last).toEqual({ archiveId: prior.review.candidate.archiveId, selectionRevision: 1 });
      await rejected(page, 'b', 'guard', { expected, text: 'stale' }, 'CONFLICT');
      expect(await call(page, 'a', 'fixtureCount', { archiveId: 'default' })).toBe(0);
      expect(await call(page, 'a', 'guard', { expected: last, text: 'selected checkpoint' })).toBe(1);
      host.checks.push('two actual workers race one atomic selection/receipt; stale guard performs no real fixture write, current guard succeeds');

      for (const key of ['schemaVersion', 'canonicalRecords', 'syncOperations', 'blobCount', 'blobBytes', 'streamingGenerations']) {
        const changed = structuredClone(prior); changed.review.candidate[key]++;
        await rejected(page, 'a', 'status', { operationId: prior.operationId, payload: changed }, 'CONFLICT');
      }
      for (const changed of [
        { ...prior, expectedSelection: { ...prior.expectedSelection, selectionRevision: 2 } },
        { ...prior, review: { ...prior.review, expectedRevision: 11 } },
        { ...prior, review: { ...prior.review, token: id() } },
        { ...prior, review: { ...prior.review, jobId: id() } },
        { ...prior, review: { ...prior.review, candidate: { ...prior.review.candidate, defaultWorkspaceId: id() } } },
        { ...prior, review: { ...prior.review, candidate: { ...prior.review.candidate, manifestSha256: 'b'.repeat(64) } } },
      ]) await rejected(page, 'a', 'status', { operationId: prior.operationId, payload: changed }, 'CONFLICT');
      const huge = { ...activation(last), surprise: 'x'.repeat(50_000) };
      await rejected(page, 'a', 'activate', { activation: huge }, 'INVALID_REQUEST');
      expect((await call(page, 'a', 'status', { operationId: huge.operationId })).status).toBe('not_found');
      host.checks.push('full normalized review identity fences every candidate summary count, workspace, digest, token, job, source high-water and selection revision; oversized/unknown fields rejected before writes');

      for (const mode of ['return', 'throw', 'cancel-before', 'cancel-throw']) {
        const value = activation(last); await candidate(page, 'a', value);
        await rejected(page, 'a', 'activate', { activation: value, mode }, mode.startsWith('cancel') ? 'CANCELLED' : undefined);
        expect(await call(page, 'a', 'expired')).toBe(true);
        expect((await call(page, 'a', 'status', { operationId: value.operationId })).status).toBe('failed');
        expect(await call(page, 'a', 'read')).toEqual(last);
      }
      for (const mode of ['double', 'throw-after', 'cancel-after']) {
        const value = activation(last); await candidate(page, 'a', value);
        const receipt = await call(page, 'a', 'activate', { activation: value, mode }); last = receipt.selected;
        expect(await call(page, 'a', 'expired')).toBe(true);
      }
      const replay = await call(page, 'b', 'activate', { activation: prior, mode: 'throw' });
      expect(replay.selected.selectionRevision).toBe(1); expect(await call(page, 'b', 'read')).toEqual(last);
      const switchBack = activation(last); switchBack.review.candidate = structuredClone(prior.review.candidate);
      await rejected(page, 'b', 'activate', { activation: switchBack }, 'CONFLICT');
      host.checks.push('single-use callback expires after return/throw; precommit cancellation stays cancelled, committed cleanup failures stay committed; same-ID old receipt survives later switch; retained archive cannot become arbitrary switch target');

      const full = activation(last); await candidate(page, 'a', full);
      await rejected(page, 'a', 'activate', { activation: full, fault: 'full' });
      expect(await call(page, 'a', 'read')).toEqual(last); expect((await call(page, 'a', 'status', { operationId: full.operationId })).status).toBe('failed');
      if (name === 'chromium') {
        const value = activation(last); await candidate(page, 'a', value);
        for (const worker of page.workers()) await worker.evaluate(() => {
          globalThis.quotaFailures = [];
          for (const method of ['write', 'truncate']) {
            const original = FileSystemSyncAccessHandle.prototype[method];
            FileSystemSyncAccessHandle.prototype[method] = function (...args) {
              try { return original.apply(this, args); }
              catch (error) { globalThis.quotaFailures.push({ name: error.name, method }); throw error; }
            };
          }
        });
        const session = await context.newCDPSession(page), origin = 'http://127.0.0.1:4203';
        const usage = await session.send('Storage.getUsageAndQuota', { origin }), quotaSize = Math.ceil(usage.usage) + 262144;
        expect(quotaSize).toBeLessThan(32 * 1024 * 1024);
        try {
          await session.send('Storage.overrideQuotaForOrigin', { origin, quotaSize });
          await rejected(page, 'a', 'activate', { activation: value, fault: 'quota' });
          host.quota = { quotaSize, usage: usage.usage, failures: (await Promise.all(page.workers().map(worker => worker.evaluate(() => globalThis.quotaFailures)))).flat() };
          expect(host.quota.failures.some(error => error.name === 'QuotaExceededError')).toBe(true);
        } finally { await session.send('Storage.overrideQuotaForOrigin', { origin }); await session.detach(); }
        expect(await call(page, 'a', 'read')).toEqual(last);
        expect((await call(page, 'a', 'status', { operationId: value.operationId })).status).not.toBe('committed');
        host.checks.push('actual Chromium OPFS quota denies bounded 8MiB transaction writes; restoring quota preserves prior selection and absence of committed receipt');
      } else host.quota = { status: 'skipped', reason: 'WebKit has no equivalent CDP quota override; real SQLite FULL rollback is exercised independently.' };
      for (const fault of ['lost-commit', 'unknown-commit']) {
        const value = activation(last); await candidate(page, 'a', value);
        if (fault === 'lost-commit') last = (await call(page, 'a', 'activate', { activation: value, fault })).selected;
        else {
          await rejected(page, 'a', 'activate', { activation: value, fault }, 'UNKNOWN_OUTCOME');
          last = (await call(page, 'b', 'status', { operationId: value.operationId, payload: value })).receipt.selected;
        }
        expect(await call(page, 'b', 'read')).toEqual(last);
      }
      host.checks.push('real SQLite FULL rolls back head/receipt/retention; lost COMMIT confirmation reconciles committed receipt, unreadable connection plus cancellation reports UNKNOWN_OUTCOME then recovers committed status');

      pending = activation(last); await candidate(page, 'a', pending);
      await start(page, 'a', 'activate', { activation: pending, mode: 'hold-before' }, 'pending'); await phase(page, 'a', 'intent-prepared');
      await page.evaluate(() => window.managedProof.kill('a'));
      expect((await call(page, 'b', 'status', { operationId: pending.operationId })).status).toBe('interrupted'); expect(await call(page, 'b', 'read')).toEqual(last);
      last = (await call(page, 'b', 'activate', { activation: pending })).selected;
      await create(page, 'a'); await call(page, 'a', 'open', { namespace, noInitializer: true });
      const inTransaction = activation(last); await candidate(page, 'a', inTransaction);
      await start(page, 'a', 'activate', { activation: inTransaction, fault: 'terminate-in-transaction' }, 'sql-transaction'); await phase(page, 'a', 'transaction-open');
      await page.evaluate(() => window.managedProof.kill('a'));
      expect(await call(page, 'b', 'read')).toEqual(last); expect((await call(page, 'b', 'status', { operationId: inTransaction.operationId })).status).toBe('interrupted');
      host.checks.push('actual worker termination after prepared intent and inside head/receipt SQL transaction recovers interrupted intent and prior selection; explicit same-ID retry revalidates before commit');

      await create(page, 'a'); await call(page, 'a', 'open', { namespace, noInitializer: true });
      const lostReply = activation(last); await candidate(page, 'a', lostReply);
      await start(page, 'a', 'activate', { activation: lostReply, mode: 'hold-after' }, 'lost-reply'); await phase(page, 'a', 'selection-committed');
      await page.evaluate(() => window.managedProof.kill('a'));
      last = (await call(page, 'b', 'status', { operationId: lostReply.operationId })).receipt.selected;
      const next = activation(last); await candidate(page, 'b', next); last = (await call(page, 'b', 'activate', { activation: next })).selected;
      expect((await call(page, 'b', 'activate', { activation: lostReply })).selected.selectionRevision).toBeLessThan(last.selectionRevision);
      expect(await call(page, 'b', 'read')).toEqual(last);
      host.checks.push('lost real committed reply remains recoverable after a later switch without switching back');

      const closeFailure = activation(last); await candidate(page, 'b', closeFailure);
      last = (await call(page, 'b', 'activate', { activation: closeFailure, fault: 'close-after-commit' })).selected;
      await rejected(page, 'b', 'read', {}, 'UNAVAILABLE');
      await create(page, 'a'); await call(page, 'a', 'open', { namespace, noInitializer: true }); expect(await call(page, 'a', 'read')).toEqual(last);
      host.checks.push('postcommit pool-close failure preserves committed receipt and poisons that instance; new owner reopens confirmed selection');

      for (const scenario of ['missing-directory', 'missing-file', 'missing-selected', 'corrupt-header']) {
        const isolated = `test-${id()}`; await create(page, scenario); await call(page, scenario, 'open', { namespace: isolated });
        const value = activation(await call(page, scenario, 'read')); await candidate(page, scenario, value); await call(page, scenario, 'activate', { activation: value });
        if (scenario === 'missing-directory') await call(page, scenario, 'deleteCatalogDirectory');
        else if (scenario === 'missing-file') expect(await call(page, scenario, 'deleteCatalogFile')).toBe(true);
        else if (scenario === 'missing-selected') await call(page, scenario, 'deleteArchive', { archiveId: value.review.candidate.archiveId });
        else expect(await call(page, scenario, 'damage')).toBe(true);
        const before = await call(page, scenario, 'initializations');
        await rejected(page, scenario, 'read', {}, 'UNAVAILABLE'); expect(await call(page, scenario, 'initializations')).toBe(before);
        if (scenario === 'missing-selected') {
          expect((await call(page, scenario, 'status', { operationId: value.operationId, payload: value })).status).toBe('committed');
          expect((await call(page, scenario, 'activate', { activation: value, mode: 'throw' })).selected.archiveId).toBe(value.review.candidate.archiveId);
          await rejected(page, scenario, 'guard', { expected: { archiveId: value.review.candidate.archiveId, selectionRevision: 1 } }, 'UNAVAILABLE');
        }
      }
      host.checks.push('missing catalog/file or physical header corruption fail unavailable; missing selected namespace blocks read/guard but global receipt status and same-ID committed replay remain inspectable without default recreation');

      pending = activation(last); await candidate(page, 'a', pending);
      await start(page, 'a', 'activate', { activation: pending, mode: 'hold-before' }, 'process-pending'); await phase(page, 'a', 'intent-prepared');
    } finally { await context.close(); }
    context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await visit(); await create(page, 'restart');
      expect(await call(page, 'restart', 'open', { namespace, noInitializer: true })).toEqual(last);
      expect((await call(page, 'restart', 'status', { operationId: pending.operationId, payload: pending })).status).toBe('interrupted');
      expect((await call(page, 'restart', 'status', { operationId: prior.operationId, payload: prior })).receipt.selected.selectionRevision).toBe(1);
      host.checks.push('complete persistent browser-process restart retains active head and old committed receipt, distinguishing interrupted pending validation');
    } finally { await context.close(); }
    host.status = 'passed'; await save(); console.log(`${name}: managed selection passed ${host.checks.length} checks`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
