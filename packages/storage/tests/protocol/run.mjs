import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const engines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, '../../../..');
const frozen = resolve(import.meta.dirname, '../selection/schema8/frozen');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', startedAt: new Date().toISOString(), selectedEngines: engines.map(([name]) => name), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, sourceSha256: {}, hosts: [] };
const output = resolve(root, 'test-results/archive-protocol.json');
const save = async () => { await mkdir(resolve(root, 'test-results'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
await save();
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-protocol-'));
let server;
const call = (page, method, ...args) => page.evaluate(({ method, args }) => window.protocolProof[method](...args), { method, args });
const wait = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 15_000 });
const snapshot = d => ({ canonicalRecords: d.canonicalRecords, syncOperations: d.syncOperations, integrity: d.integrity });
try {
  const manifest = JSON.parse(await readFile(resolve(frozen, 'manifest.json'), 'utf8')); report.frozen = manifest;
  const outDir = resolve(temporary, 'dist');
  for (const file of ['packages/storage/src/archive-protocol.ts', 'packages/storage/src/client/archive.ts', 'packages/storage/src/client/selection.ts', 'packages/storage/src/worker/archive.ts', 'packages/storage/src/worker/archive-runtime.ts', 'packages/storage/src/worker/archive-database.ts', 'packages/storage/src/worker/selection.ts', 'packages/storage/src/selection/managed-catalog.ts', 'packages/storage/src/worker/sqlite-module.ts', 'packages/storage/migrations/index.ts', 'packages/storage/migrations/archive-access.ts', 'packages/storage/tests/protocol/index.mjs', 'packages/storage/tests/protocol/run.mjs', 'tooling/browser-engines.mjs']) report.sourceSha256[file] = hash(await readFile(resolve(root, file)));
  await build({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  report.builtArtifacts = {};
  for (const file of await readdir(outDir, { recursive: true })) {
    if (/\.(js|mjs|wasm|html)$/.test(file)) report.builtArtifacts[file] = hash(await readFile(resolve(outDir, file)));
  }
  await mkdir(resolve(outDir, 'frozen'), { recursive: true });
  for (const [file, digest] of Object.entries(manifest.artifacts)) {
    const source = file.endsWith('.wasm') ? resolve(root, 'packages/storage/sqlite/dist/sqlite3.wasm') : resolve(frozen, file);
    expect(hash(await readFile(source))).toBe(digest); await copyFile(source, resolve(outDir, 'frozen', file));
  }
  // The managed default namespace is intentionally fixed. Give every invocation
  // a fresh origin as well as disposable profiles; never rely on old site state.
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, logLevel: 'warn', preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Preview did not bind a TCP address');
  const origin = `http://127.0.0.1:${address.port}`; report.origin = origin;
  for (const [name, engine] of engines) {
    const host = { name, status: 'running', checks: [], rejected: [], observations: {} }; report.hosts.push(host); await save();
    const context = await engine.launchPersistentContext(resolve(temporary, name), { headless: true });
    try {
      const page = await context.newPage(); await page.goto(origin); await wait(page, () => !!window.protocolProof);
      host.userAgent = await page.evaluate(() => navigator.userAgent);
      // Only disposable proof profiles: remove the two synthetic default stores
      // before opening a worker. WebKit can retain origin data across launches.
      host.observations.fixtureReset = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory(), removed = [];
        for (const name of ['quixi', 'quixi-selection']) {
          try { await root.removeEntry(name, { recursive: true }); removed.push(name); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }
        return removed;
      });
      const selection = await call(page, 'client', 'owner');
      const archiveId = selection.archiveId, lockName = `quixi:archive:${archiveId}:owner`;
      expect(archiveId).toBe('default'); host.observations.selection = selection;
      await call(page, 'bus', 'v1', archiveId, 1); await call(page, 'bus', 'v4', archiveId, 4); await call(page, 'bus', 'legacy-v2', archiveId, 2); await call(page, 'hello', 'legacy-v2', 2); await call(page, 'bus', 'legacy-v3', archiveId, 3); await call(page, 'hello', 'legacy-v3', 3);
      const owner = await call(page, 'request', 'owner', 'diagnostics');
      expect(owner.integrity).toBe('ok'); expect(owner.schemaVersion).toBe(13);
      await call(page, 'write', 'owner', 'modern owner committed');
      expect(await call(page, 'client', 'follower')).toEqual(selection);
      expect((await call(page, 'request', 'follower', 'diagnostics')).ownerId).toBe(owner.ownerId);
      await wait(page, async lock => (await navigator.locks.query()).pending.filter(item => item.name === lock).length === 1, lockName);
      await call(page, 'write', 'follower', 'modern follower forwarded');
      expect((await call(page, 'request', 'owner', 'diagnostics')).syncOperations).toBe(2);
      host.checks.push('Actual modern owner and follower commit through production client; common owner identity and held/pending owner locks observed');

      await call(page, 'raw', 'old', true); await call(page, 'init', 'old', selection, null);
      await wait(page, () => window.protocolProof.busMessages('v1').some(frame => frame.type === 'hello'));
      await wait(page, async lock => (await navigator.locks.query()).pending.filter(item => item.name === lock).length === 2, lockName);
      await call(page, 'queuedOldWrite', 'old', 'old-write');
      await call(page, 'write', 'follower', 'modern follower progresses while old waits');
      const before = await call(page, 'request', 'owner', 'diagnostics'); expect(before.syncOperations).toBe(3);
      expect((await call(page, 'job', 'old-write')).status).toBe('pending');
      expect((await call(page, 'busMessages', 'v1')).filter(frame => frame.type === 'owner')).toHaveLength(0);
      host.observations.waitingLocks = await page.evaluate(() => navigator.locks.query());
      host.checks.push('Unmodified frozen schema8 follower announces v1 hello and waits on the same lock; modern owner never advertises on v1 and old canonical call remains undispatched while modern commits progress');

      const previousOwners = (await call(page, 'busMessages', 'v4')).filter(frame => frame.type === 'owner').length;
      host.observations.invalidBusCallIds = await call(page, 'invalidBusWrites', 'v4', owner.ownerId, selection);
      await wait(page, count => window.protocolProof.busMessages('v4').filter(frame => frame.type === 'owner').length > count, previousOwners);
      expect(snapshot(await call(page, 'request', 'follower', 'diagnostics'))).toEqual(snapshot(before));
      await call(page, 'write', 'follower', 'modern commit after stale bus burst');
      expect((await call(page, 'request', 'owner', 'diagnostics')).syncOperations).toBe(4);
      const v4Frames = await call(page, 'busMessages', 'v4');
      expect(v4Frames.every(frame => frame.version === 4)).toBe(true);
      expect((await call(page, 'busMessages', 'legacy-v2')).filter(frame => frame.type === 'owner')).toHaveLength(0);
      expect((await call(page, 'busMessages', 'legacy-v3')).filter(frame => frame.type === 'owner')).toHaveLength(0);
      expect(v4Frames.some(frame => frame.type === 'call' && frame.call.request.version === 1)).toBe(true);
      host.observations.productionBusTypes = [...new Set(v4Frames.map(frame => frame.type))];
      host.checks.push('Missing, numeric v1/v2/v3/v5 and string-version calls sent to v4 cannot commit; same-sender valid hello is an owner-processing barrier and subsequent production calls still succeed');

      await call(page, 'raw', 'direct'); await call(page, 'init', 'direct', selection);
      expect((await call(page, 'rawRequest', 'direct', 'diagnostics', null)).ok).toBe(true);
      const directBaseline = await call(page, 'request', 'owner', 'diagnostics');
      for (const version of [null, 1, 2, 3, 5, '4']) {
        const reply = await call(page, 'rawWrite', 'direct', 'invalid direct version must not commit', version);
        expect(reply.ok).toBe(false); expect(reply.version).toBe(4); expect(reply.error.code).toBe('UNSUPPORTED'); host.rejected.push(reply);
      }
      expect(snapshot(await call(page, 'request', 'owner', 'diagnostics'))).toEqual(snapshot(directBaseline));
      expect((await call(page, 'rawWrite', 'direct', 'valid direct after rejected frames')).ok).toBe(true);
      expect((await call(page, 'request', 'follower', 'diagnostics')).syncOperations).toBe(5);
      expect((await call(page, 'messages', 'direct')).every(frame => frame.version === 4)).toBe(true);
      host.checks.push('Initialized actual worker rejects missing/wrong direct outer versions with UNSUPPORTED before mutation, then accepts legitimate version4 call with inner request version1');

      for (const [index, version] of [null, 1, 2, 3, 5, '4'].entries()) {
        const worker = `bad-init-${index}`, rejectedArchive = `protocol-rejected-${randomUUID()}`;
        await call(page, 'raw', worker); await call(page, 'init', worker, { archiveId: rejectedArchive, selectionRevision: selection.selectionRevision }, version);
        await wait(page, name => window.protocolProof.messages(name).some(frame => frame.type === 'fatal'), worker);
        const fatal = (await call(page, 'messages', worker)).find(frame => frame.type === 'fatal');
        expect(fatal.version).toBe(4); expect(fatal.error.code).toBe('UNSUPPORTED'); host.rejected.push(fatal);
        expect(await call(page, 'namespaceExists', rejectedArchive)).toBe(false);
        const locks = await page.evaluate(() => navigator.locks.query());
        expect([...locks.held, ...locks.pending].some(lock => lock.name === `quixi:archive:${rejectedArchive}:owner`)).toBe(false);
        await call(page, 'terminate', worker);
      }
      await call(page, 'write', 'owner', 'modern owner remains healthy after init rejections');
      const final = await call(page, 'request', 'follower', 'diagnostics'); expect(final.syncOperations).toBe(6); expect(final.integrity).toBe('ok');
      host.observations.final = final;
      host.checks.push('Missing/wrong direct init versions fail before OPFS namespace or owner lock exists; separate established modern session remains writable');
      expect((await call(page, 'job', 'old-write')).status).toBe('pending');
      expect((await call(page, 'busMessages', 'v1')).filter(frame => frame.type === 'owner')).toHaveLength(0);
      await call(page, 'terminate', 'direct');
      await call(page, 'closeClient', 'follower'); await call(page, 'closeClient', 'owner');
      await wait(page, () => window.protocolProof.job('old-write')?.status !== 'pending');
      const oldFailure = await call(page, 'job', 'old-write');
      expect(oldFailure.status).toBe('failed'); expect(oldFailure.reply.error.code).toBe('MIGRATION_FAILED');
      host.observations.oldWaiterAfterOwnerExit = oldFailure;
      await call(page, 'terminate', 'old');
      await wait(page, async lock => { const q = await navigator.locks.query(); return ![...q.held, ...q.pending].some(item => item.name === lock); }, lockName);
      expect(await call(page, 'client', 'reopened')).toEqual(selection);
      const reopened = await call(page, 'request', 'reopened', 'diagnostics');
      expect(snapshot(reopened)).toEqual(snapshot(final)); expect(reopened.schemaVersion).toBe(13);
      await call(page, 'closeClient', 'reopened');
      host.checks.push('After modern owner exits, frozen schema8 waiter acquires the same lock and refuses the current schema before its queued mutation; modern reopen preserves six committed operations and integrity');
    } finally { await context.close(); }
    host.status = 'passed'; await save(); console.log(`${name}: archive protocol passed ${host.checks.length} checks`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
