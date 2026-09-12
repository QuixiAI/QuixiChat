import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  for (const file of ['packages/storage/src/client/retained-archive.ts', 'packages/storage/src/worker/retained-archive.ts', 'packages/storage/src/worker/archives/index.ts', 'packages/storage/src/worker/archives/clean-copy.ts', 'packages/storage/src/worker/sqlite-module.ts', 'packages/storage/src/worker/canonical/repository.ts', 'packages/storage/src/worker/views.ts', 'packages/storage/src/worker/archives/schema-validation.ts', 'packages/storage/src/worker/rescue-export.ts', 'packages/storage/src/client/rescue-export.ts', 'packages/storage/src/worker/archives/rescue-format.ts', 'packages/storage/src/worker/archives/format.ts', 'packages/storage/src/worker/archives/tar.ts', 'packages/storage/migrations/index.ts', 'packages/storage/migrations/archive-access.ts', 'packages/storage/sqlite/dist/sqlite3.mjs', 'packages/storage/sqlite/dist/sqlite3.wasm', 'packages/storage/tests/retained/index.mjs', 'packages/storage/tests/retained/run.mjs', 'packages/storage/tests/retained/fixture-worker.mjs']) report.sourceSha256[file] = hash(await readFile(resolve(root, file)));
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
      for (const version of [1,2,3]) expect((await call(page, 'raw', 'commit', 'default', version)).error.code).toBe('UNSUPPORTED');
      const missingNamespace = randomUUID();
      expect((await call(page, 'read', missingNamespace, 'readEntities', { collection: 'threads', threadId: null, page: pageBudget })).code).toBe('NOT_FOUND');
      expect(await call(page, 'namespaceExists', missingNamespace)).toBe(false);
      expect((await call(page, 'raw', 'readEntity', 'default', 4, { collection: 'threads', id: 'invalid' })).error.code).toBe('INVALID_REQUEST');
      expect((await call(page, 'raw', 'readEntities', 'default', 4, { collection: 'threads', threadId: null, page: { ...pageBudget, cursor: 'x'.repeat(262144) } })).error.code).toBe('INVALID_REQUEST');
      const oversizedIdentity = await call(page, 'raw', 'readEntity', 'x'.repeat(262144), 4, null, 'x'.repeat(262144));
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
      // Rescue export: exact bytes and blob files without opening the schema.
      const planted = await call(page, 'private', 'plant-blob', fixture.candidateId);
      const databaseBytes = await call(page, 'private', 'database-bytes', fixture.candidateId);
      const rescueBefore = await call(page, 'private', 'snapshot', fixture.candidateId);
      const rescue = await call(page, 'rescue', fixture.candidateId);
      expect(rescue.ok).toBe(true);
      const tarBytes = Buffer.from(rescue.base64, 'base64');
      expect(tarBytes.length).toBe(rescue.summary.byteLength); expect(hash(tarBytes)).toBe(rescue.summary.sha256);
      const tarPath = resolve(temporary, `${name}-rescue.tar`); await writeFile(tarPath, tarBytes);
      expect(execFileSync('tar', ['-tf', tarPath], { encoding: 'utf8' }).trim().split('\n')).toEqual(['format.json', 'quixi.sqlite', `blobs/${planted.sha256}`, 'checksums.jsonl', 'manifest.json']);
      const extracted = resolve(temporary, `${name}-rescue`); await mkdir(extracted, { recursive: true });
      execFileSync('tar', ['-xf', tarPath, '-C', extracted]);
      const database = await readFile(resolve(extracted, 'quixi.sqlite'));
      expect(database.length).toBe(databaseBytes.byteLength); expect(hash(database)).toBe(databaseBytes.sha256);
      expect(hash(await readFile(resolve(extracted, 'blobs', planted.sha256)))).toBe(planted.sha256);
      expect(JSON.parse(await readFile(resolve(extracted, 'format.json'), 'utf8'))).toEqual({ format: 'quixi-archive', version: 1, kind: 'rescue' });
      const manifest = JSON.parse(await readFile(resolve(extracted, 'manifest.json'), 'utf8'));
      expect(manifest.recovery.databaseSha256).toBe(databaseBytes.sha256); expect(manifest.recovery.databaseBytes).toBe(databaseBytes.byteLength);
      expect(manifest.recovery.header.pageCount * manifest.recovery.header.pageSize).toBe(databaseBytes.byteLength);
      expect(manifest.recovery.ledgerCompatible).toBe(true); expect(manifest.recovery.ledger.length).toBe(manifest.recovery.buildMigrations); expect(manifest.recovery.ledgerError).toBe(null);
      expect(manifest.recovery.blobFiles).toBe(1); expect(manifest.recovery.blobHashMismatches).toBe(0); expect(manifest.recovery.unrecognizedFiles).toBe(1);
      const checksums = (await readFile(resolve(extracted, 'checksums.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(checksums.map(item => item.path)).toEqual(['format.json', 'quixi.sqlite', `blobs/${planted.sha256}`]);
      expect(checksums[1].sha256).toBe(databaseBytes.sha256); expect(manifest.inventory.entries).toBe(3);
      expect(await call(page, 'private', 'snapshot', fixture.candidateId)).toEqual(rescueBefore);
      host.rescue = { byteLength: rescue.summary.byteLength, sha256: rescue.summary.sha256, chunks: rescue.chunks, recovery: manifest.recovery };
      host.checks.push('Rescue export streams the exact pool database bytes and blob files into the standard TAR layout with a recovery manifest, skips unrecognized blob names and leaves every archive file byte unchanged');
      const futureId = randomUUID();
      await call(page, 'private', 'clone', fixture.candidateId, futureId); await call(page, 'private', 'future-ledger', futureId);
      const futureBefore = await call(page, 'private', 'snapshot', futureId);
      const futureRescue = await call(page, 'rescue', futureId);
      expect(futureRescue.ok).toBe(true); expect(futureRescue.summary.manifest.recovery.ledgerCompatible).toBe(false);
      expect(futureRescue.summary.manifest.recovery.ledger.at(-1).name).toBe('future');
      expect(await call(page, 'private', 'snapshot', futureId)).toEqual(futureBefore);
      host.checks.push('An archive with a future migration ledger this build cannot open is still rescued byte-exactly, with its ledger recorded as found and marked incompatible');
      await call(page, 'open');
      expect((await call(page, 'rescue', 'default')).code).toBe('CONFLICT');
      await call(page, 'close');
      const hotId = randomUUID();
      await call(page, 'private', 'clone', fixture.candidateId, hotId);
      await call(page, 'private', 'hot', hotId); await call(page, 'killHeld');
      await page.waitForFunction(async lockName => { const locks = await navigator.locks.query(); return !locks.held.some(lock => lock.name === lockName); }, `quixi:archive:${hotId}:owner`);
      const hotBefore = await call(page, 'private', 'snapshot', hotId);
      expect((await call(page, 'rescue', hotId)).code).toBe('IO_ERROR');
      expect(await call(page, 'private', 'snapshot', hotId)).toEqual(hotBefore);
      const missingId = randomUUID(); await call(page, 'private', 'missing', missingId);
      expect((await call(page, 'rescue', missingId)).code).toBe('NOT_FOUND');
      expect((await call(page, 'rescue', randomUUID())).code).toBe('NOT_FOUND');
      expect((await call(page, 'rescue', 'test-not-production')).code).toBe('INVALID_REQUEST');
      const concurrent = await call(page, 'rescueConcurrent', fixture.candidateId);
      expect(concurrent.ok).toBe(1); expect(concurrent.codes.filter(code => code === 'OVERLOADED')).toHaveLength(1);
      host.checks.push('Rescue export refuses a held owner, an interrupted journal, a missing or absent database, an invalid identity and a concurrent export without changing any file');
      // Rescue restore: the raw database is cleaned into a fresh candidate and
      // validated exactly like a portable restore at this build's schema.
      await call(page, 'open');
      const restored = await call(page, 'rescueRestore', rescue.base64);
      expect(restored.state).toBe('ready'); expect(restored.candidate.schemaVersion).toBe(manifest.recovery.buildMigrations);
      expect(restored.candidate.canonicalRecords).toBeGreaterThan(0); expect(restored.candidate.blobCount).toBe(0);
      await call(page, 'close');
      const restoredThread = await call(page, 'read', restored.candidate.archiveId, 'readEntity', { collection: 'threads', id: fixture.threadId });
      expect(restoredThread.ok).toBe(true); expect(restoredThread.result.id).toBe(fixture.threadId);
      const restoredFiles = await call(page, 'private', 'snapshot', restored.candidate.archiveId);
      expect(restoredFiles.some(file => file.path.includes(planted.sha256))).toBe(false);
      expect(await call(page, 'private', 'snapshot', fixture.candidateId)).toEqual(rescueBefore);
      host.rescueRestore = { candidate: restored.candidate, files: restoredFiles.length };
      host.checks.push('A rescue archive restores into an isolated ready candidate at this build\'s schema; its history reads back exactly, the unreferenced planted blob is dropped and the source files are unchanged');
      const defaultRescue = await call(page, 'rescue', 'default');
      expect(defaultRescue.ok).toBe(true); expect(defaultRescue.summary.manifest.recovery.ledgerCompatible).toBe(true);
      await call(page, 'open');
      const restoredDefault = await call(page, 'rescueRestore', defaultRescue.base64);
      expect(restoredDefault.state).toBe('ready'); expect(restoredDefault.candidate.canonicalRecords).toBeGreaterThan(restored.candidate.canonicalRecords);
      const futureRestore = await call(page, 'rescueRestore', futureRescue.base64);
      expect(futureRestore.state).toBe('failed'); expect(JSON.stringify(futureRestore)).toMatch(/schema version \d+ is not supported by this Quixi version/);
      await call(page, 'close');
      const restoredDefaultThread = await call(page, 'read', restoredDefault.candidate.archiveId, 'readEntity', { collection: 'threads', id: fixture.laterThreadId });
      expect(restoredDefaultThread.ok).toBe(true);
      host.checks.push('The live default archive, including its local selection state and claims, rescues and restores into a clean ready candidate; a future-ledger rescue is refused naming the schema versions');
      // Older-prefix rescue restore: a genuine schema-8 archive, whose objects
      // and ledger equal a fresh migrations 1–8 database, restores after the
      // isolated candidate is upgraded through the fresh-schema copy; the
      // schema-7 floor and a tampered ledger are refused naming the version.
      const prefixId = randomUUID();
      await call(page, 'private', 'clone', fixture.candidateId, prefixId);
      const downgraded = await call(page, 'private', 'downgrade', prefixId, 8);
      expect(downgraded.matchesFresh).toBe(true); expect(downgraded.ledger).toBe(8); expect(downgraded.dropped).toBeGreaterThan(0); expect(downgraded.integrity).toBe('ok');
      const prefixBefore = await call(page, 'private', 'snapshot', prefixId);
      const prefixRescue = await call(page, 'rescue', prefixId);
      expect(prefixRescue.ok).toBe(true); expect(prefixRescue.summary.manifest.recovery.ledgerCompatible).toBe(true); expect(prefixRescue.summary.manifest.recovery.ledger).toHaveLength(8);
      const floorId = randomUUID(); await call(page, 'private', 'clone', fixture.candidateId, floorId);
      const floorDowngrade = await call(page, 'private', 'downgrade', floorId, 7); expect(floorDowngrade.matchesFresh).toBe(true); expect(floorDowngrade.recreated).toBeGreaterThan(0);
      const floorRescue = await call(page, 'rescue', floorId); expect(floorRescue.ok).toBe(true); expect(floorRescue.summary.manifest.recovery.ledgerCompatible).toBe(true);
      const tamperedId = randomUUID(); await call(page, 'private', 'clone', fixture.candidateId, tamperedId); await call(page, 'private', 'bad-ledger', tamperedId);
      const tamperedRescue = await call(page, 'rescue', tamperedId); expect(tamperedRescue.ok).toBe(true); expect(tamperedRescue.summary.manifest.recovery.ledgerCompatible).toBe(false);
      await call(page, 'open');
      const prefixRestore = await call(page, 'rescueRestore', prefixRescue.base64);
      expect(prefixRestore.state).toBe('ready'); expect(prefixRestore.sourceSchemaVersion).toBe(8);
      expect(prefixRestore.candidate.schemaVersion).toBe(manifest.recovery.buildMigrations);
      expect(prefixRestore.candidate.canonicalRecords).toBe(restored.candidate.canonicalRecords); expect(prefixRestore.candidate.syncOperations).toBe(restored.candidate.syncOperations);
      const floorRestore = await call(page, 'rescueRestore', floorRescue.base64);
      expect(floorRestore.state).toBe('failed'); expect(JSON.stringify(floorRestore)).toMatch(/schema version 7 predates the earliest schema this Quixi version can upgrade \(schema 8\)/);
      const tamperedRestore = await call(page, 'rescueRestore', tamperedRescue.base64);
      expect(tamperedRestore.state).toBe('failed'); expect(JSON.stringify(tamperedRestore)).toMatch(/migration 1 \(canonical_records_and_atomic_operations\) differs from this Quixi version's migration history/);
      await call(page, 'close');
      const prefixReads = await call(page, 'allReads', prefixRestore.candidate.archiveId);
      expect(prefixReads).toEqual(candidate);
      expect(await call(page, 'private', 'snapshot', prefixId)).toEqual(prefixBefore);
      host.rescuePrefixRestore = { downgraded, floorDowngrade, candidate: prefixRestore.candidate, sourceSchemaVersion: prefixRestore.sourceSchemaVersion };
      host.checks.push('A genuine schema-8 rescue archive, whose objects and ledger equal a fresh migrations 1–8 database, restores into a ready candidate upgraded to this build\'s schema whose nine approved reads equal the schema-12 candidate\'s and whose rescued files are unchanged; a schema-7 archive and a tampered ledger are refused naming the version');
    } finally { await context.close(); }
    host.status = 'passed'; await save(); console.log(`${name}: retained archive passed ${host.checks.length} checks`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
