import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
const root = resolve(import.meta.dirname, '../../../..'), engines = browserEngines({ chromium, webkit });
const report = { status: 'running', startedAt: new Date().toISOString(), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, selectedEngines: engines.map(([name]) => name), sourceSha256: {}, hosts: [] };
const output = resolve(root, 'test-results/retained-archive.json');
const save = async () => { await mkdir(resolve(root, 'test-results'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
await save();
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-retained-')); let server;
const hash = value => createHash('sha256').update(value).digest('hex');
const call = (page, method, ...args) => page.evaluate(({ method, args }) => window.retainedProof[method](...args), { method, args });
const pageBudget = { maxItems: 8, maxBytes: 65536, cursor: null };
try {
  for (const file of ['packages/storage/src/client/retained-archive.ts', 'packages/storage/src/worker/retained-archive.ts', 'packages/storage/src/worker/sqlite-module.ts', 'packages/storage/src/worker/canonical/repository.ts', 'packages/storage/src/worker/views.ts', 'packages/storage/src/worker/archives/schema-validation.ts', 'packages/storage/migrations/index.ts', 'packages/storage/migrations/archive-access.ts', 'packages/storage/sqlite/dist/sqlite3.mjs', 'packages/storage/sqlite/dist/sqlite3.wasm', 'packages/storage/tests/retained/index.mjs', 'packages/storage/tests/retained/run.mjs', 'packages/storage/tests/retained/fixture-worker.mjs']) report.sourceSha256[file] = hash(await readFile(resolve(root, file)));
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  report.builtArtifacts = {};
  for (const file of await readdir(outDir, { recursive: true })) if (/\.(js|wasm|html)$/.test(file)) report.builtArtifacts[file] = hash(await readFile(resolve(outDir, file)));
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  report.origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const [name, engine] of engines) {
    const host = { name, status: 'running', checks: [] }; report.hosts.push(host); await save();
    const context = await engine.launchPersistentContext(resolve(temporary, name), { headless: true });
    try {
      const page = await context.newPage(); await page.goto(report.origin); await page.waitForFunction(() => !!window.retainedProof);
      host.userAgent = await page.evaluate(() => navigator.userAgent);
      const fixture = await call(page, 'seed'); host.fixture = fixture;
      const collision = await call(page, 'read', 'default', 'readEntity', { collection: 'threads', id: fixture.threadId }); expect(collision.ok).toBe(false); expect(collision.code).toBe('CONFLICT');
      await call(page, 'close');
      const sourceBefore = await call(page, 'private', 'snapshot', 'default'), candidateBefore = await call(page, 'private', 'snapshot', fixture.candidateId);
      const source = await call(page, 'allReads', 'default'), candidate = await call(page, 'allReads', fixture.candidateId);
      for (const value of [source, candidate]) {
        expect(value.readEntity.id).toBe(fixture.threadId);
        expect(value.readMessageParts.items[0].data.text).toBe(fixture.text);
        expect(value.operationStatus.status).toBe('committed');
        expect(value.readThreadView.thread.id).toBe(fixture.threadId);
        expect(value.readConversationWindow.items[0].id).toBe(fixture.messageId);
        expect(value.readMessageChildren.items[0].id).toBe(fixture.messageId);
      }
      expect(source.readEntities.items).toHaveLength(2); expect(candidate.readEntities.items).toHaveLength(1);
      expect(source.readSyncOperations.items).toHaveLength(3); expect(candidate.readSyncOperations.items).toHaveLength(2);
      expect(source.listLibrary.items).toHaveLength(2); expect(candidate.listLibrary.items).toHaveLength(1);
      host.checks.push('Nine approved operations use real read-only SQLite for managed source and production restore candidate; Unicode/NUL text is exact and literal candidate ID never retargets to active default');
      const receipt = await call(page, 'read', 'default', 'operationStatus', { operationId: fixture.archiveOperationId }); expect(receipt.ok).toBe(true); expect(receipt.result.status).toBe('committed');
      const missingReceipt = await call(page, 'read', fixture.candidateId, 'operationStatus', { operationId: randomUUID() }); expect(missingReceipt.ok).toBe(true); expect(missingReceipt.result.status).toBe('not_found');
      host.checks.push('Canonical and archive-job operation receipts are readable without constructing writable archive repository');
      for (const operation of ['commit', 'archiveWorkspace', 'beginArchiveExport', 'searchArchive']) {
        const reply = await call(page, 'raw', operation, 'default'); expect(reply.ok).toBe(false); expect(reply.error.code).toBe('INVALID_REQUEST');
      }
      expect((await call(page, 'raw', 'commit', 'default', 1)).error.code).toBe('UNSUPPORTED');
      const missingNamespace = randomUUID();
      expect((await call(page, 'read', missingNamespace, 'readEntities', { collection: 'threads', threadId: null, page: pageBudget })).code).toBe('NOT_FOUND');
      expect(await call(page, 'namespaceExists', missingNamespace)).toBe(false);
      expect((await call(page, 'raw', 'readEntity', 'default', 2, { collection: 'threads', id: 'invalid' })).error.code).toBe('INVALID_REQUEST');
      expect((await call(page, 'raw', 'readEntities', 'default', 2, { collection: 'threads', threadId: null, page: { ...pageBudget, cursor: 'x'.repeat(262144) } })).error.code).toBe('INVALID_REQUEST');
      const oversizedIdentity = await call(page, 'raw', 'readEntity', 'x'.repeat(262144), 2, null, 'x'.repeat(262144));
      expect(oversizedIdentity.error.code).toBe('INVALID_REQUEST'); expect(oversizedIdentity.archiveId).toBe(''); expect(oversizedIdentity.requestId).toBe(''); expect(JSON.stringify(oversizedIdentity).length).toBeLessThan(8192);
      expect((await call(page, 'read', 'test-not-production', 'readEntities', { collection: 'threads', threadId: null, page: pageBudget })).code).toBe('INVALID_REQUEST');
      host.checks.push('Worker rejects mutations/workspace/export/search and stale envelopes before effects; missing or arbitrary namespaces have no creation fallback');
      host.admission = await call(page, 'admission', fixture.candidateId);
      expect(host.admission.peak).toBe(4); expect(host.admission.active).toBe(0); expect(host.admission.values[4].code).toBe('OVERLOADED');
      expect(host.admission.invalid.code).toBe('INVALID_REQUEST'); expect(host.admission.oversized.code).toBe('INVALID_REQUEST'); expect(host.admission.created).toBe(host.admission.beforeInvalid);
      host.timeout = await call(page, 'timeout', fixture.candidateId); expect(host.timeout.outcome.code).toBe('IO_ERROR'); expect(host.timeout.dropped).toBe(1); expect(host.timeout.terminated).toBe(1);
      expect((await call(page, 'read', fixture.candidateId, 'readEntity', { collection: 'threads', id: fixture.threadId })).ok).toBe(true);
      host.checks.push('Four-worker admission and input byte bounds reject excess work before allocation; dropped actual reply times out and terminates worker, then a fresh read succeeds');
      expect(await call(page, 'private', 'snapshot', 'default')).toEqual(sourceBefore);
      expect(await call(page, 'private', 'snapshot', fixture.candidateId)).toEqual(candidateBefore);
      host.preserved = { source: sourceBefore, candidate: candidateBefore };
      host.checks.push('Every source/candidate file hash is unchanged after approved reads, rejected writes, admission collisions and timeout cleanup');
      host.recoveryRefusals = [];
      for (const command of ['ledger8', 'ledger7', 'bad-ledger', 'future-ledger', 'metadata', 'missing', 'hot']) {
        const archiveId = randomUUID();
        if (command === 'missing') await call(page, 'private', 'missing', archiveId);
        else {
          await call(page, 'private', 'clone', fixture.candidateId, archiveId);
          const outcome = await call(page, 'private', command, archiveId);
          if (command === 'hot') {
            expect(outcome.files.some(file => file.endsWith('-journal'))).toBe(true);
            await call(page, 'killHeld');
            await page.waitForFunction(async name => { const locks = await navigator.locks.query(); return !locks.held.some(lock => lock.name === name); }, `quixi:archive:${archiveId}:owner`);
          }
        }
        const before = await call(page, 'private', 'snapshot', archiveId);
        const outcome = await call(page, 'read', archiveId, 'readEntity', { collection: 'threads', id: fixture.threadId });
        if (command === 'ledger8') { expect(outcome.ok).toBe(true); expect(outcome.result.id).toBe(fixture.threadId); }
        else { expect(outcome.ok).toBe(false); expect(outcome.code).toBe(command === 'missing' ? 'NOT_FOUND' : ['metadata', 'hot'].includes(command) ? 'IO_ERROR' : 'MIGRATION_FAILED'); }
        expect(await call(page, 'private', 'snapshot', archiveId)).toEqual(before);
        host.recoveryRefusals.push({ command, outcome, preservedFiles: before.length, snapshotSha256: hash(JSON.stringify(before)) });
      }
      host.checks.push('Compatible schema8 reads without migration; schema7/future/bad ledger, missing database, corrupt pool header and actual interrupted SQLite journal reject without changing any retained file bytes');
    } finally { await context.close(); }
    host.status = 'passed'; await save(); console.log(`${name}: retained archive passed ${host.checks.length} checks`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
