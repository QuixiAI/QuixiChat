import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const engines = browserEngines({ chromium, webkit });
const root = resolve(import.meta.dirname, '../../../../..');
const frozen = resolve(import.meta.dirname, 'frozen');
const manifest = JSON.parse(await readFile(resolve(frozen, 'manifest.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-frozen-schema8-'));
const report = { status: 'running', startedAt: new Date().toISOString(), selectedEngines: engines.map(([name]) => name), environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === 'darwin' ? execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim() : release(), node: process.version }, frozen: manifest, sourceSha256: {}, hosts: [] };
const output = resolve(root, 'test-results/schema8-writer-barrier.json');
const save = async () => { await mkdir(resolve(root, 'test-results'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
let server;
const call = (page, method, ...args) => page.evaluate(async ({ method, args }) => { try { return await window.schema8Proof[method](...args); } catch (error) { throw new Error(JSON.stringify(error)); } }, { method, args });
const wait = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 15_000 });
const close = async (page, name) => { await call(page, 'close', name); await wait(page, name => window.schema8Proof.closed(name), name); };
const refused = async (page, name, key) => {
  await call(page, 'queuedWrite', name, 'must never become canonical', key);
  await wait(page, key => window.schema8Proof.job(key)?.state !== 'pending', key);
  const result = await call(page, 'job', key);
  expect(result.state).toBe('failed'); expect(result.error.code).toBe('MIGRATION_FAILED');
  expect(result.error.message).toContain('Unsupported canonical schema version');
  return result.error;
};
const sameData = (before, after) => {
  expect(after.integrity).toBe('ok');
  for (const key of ['records', 'operations', 'transactions']) expect(after[key]).toEqual(before[key]);
};
try {
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  await mkdir(resolve(outDir, 'frozen'), { recursive: true });
  for (const [file, digest] of Object.entries(manifest.artifacts)) {
    // WASM is globally ignored; recover only the exact pinned bytes, never rebuild the old worker.
    const source = file.endsWith('.wasm') ? resolve(root, 'packages/storage/sqlite/dist/sqlite3.wasm') : resolve(frozen, file);
    expect(hash(await readFile(source))).toBe(digest);
    await copyFile(source, resolve(outDir, 'frozen', file));
  }
  for (const file of ['index.mjs', 'marker.ts', 'run.mjs', 'frozen/manifest.json']) report.sourceSha256[`packages/storage/tests/selection/schema8/${file}`] = hash(await readFile(resolve(import.meta.dirname, file)));
  report.sourceSha256['tooling/browser-engines.mjs'] = hash(await readFile(resolve(root, 'tooling/browser-engines.mjs')));
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, logLevel: 'warn', preview: { host: '127.0.0.1', port: 4202, strictPort: true } });
  for (const [name, engine] of engines) {
    const host = { name, status: 'running', checks: [], errors: [] }; report.hosts.push(host); await save();
    const profile = resolve(temporary, name), archiveId = `schema8-proof-${randomUUID()}`, candidateId = `schema8-proof-${randomUUID()}`;
    let context = await engine.launchPersistentContext(profile, { headless: true });
    const visit = async () => { const page = await context.newPage(); await page.goto('http://127.0.0.1:4202/'); await wait(page, () => !!window.schema8Proof); return page; };
    let baseline;
    try {
      const page = await visit(); host.userAgent = await page.evaluate(() => navigator.userAgent);
      await call(page, 'old', 'owner', archiveId);
      expect((await call(page, 'request', 'owner', 'diagnostics', null)).schemaVersion).toBe(8);
      await call(page, 'write', 'owner', 'old production owner committed');
      await call(page, 'old', 'follower', archiveId);
      const a = await call(page, 'request', 'owner', 'diagnostics', null), b = await call(page, 'request', 'follower', 'diagnostics', null);
      expect(a.ownerId).toBe(b.ownerId);
      await call(page, 'write', 'follower', 'old production follower forwarded');
      expect((await call(page, 'request', 'owner', 'diagnostics', null)).syncOperations).toBe(2);
      await close(page, 'follower');
      await call(page, 'marker', 'marker');
      expect(await call(page, 'markerCall', 'marker', 'probe', { archiveId })).toEqual({ acquired: false });
      host.checks.push('frozen unmodified schema8 worker is actual owner and follower; v1 forwarded canonical writes work before barrier, active owner excludes marker');

      await call(page, 'startMarker', 'marker', 'upgrade', { archiveId, mode: 'rollback' }, 'rollback');
      await wait(page, async archiveId => (await navigator.locks.query()).pending.some(item => item.name === `quixi:archive:${archiveId}:owner`), archiveId);
      await close(page, 'owner');
      await wait(page, () => window.schema8Proof.job('rollback')?.state !== 'pending');
      const rollback = await call(page, 'job', 'rollback'); expect(rollback.state).toBe('committed');
      sameData(rollback.result.before, rollback.result.after); expect(rollback.result.after.version).toBe(8);
      await call(page, 'old', 'after-rollback', archiveId);
      expect((await call(page, 'request', 'after-rollback', 'diagnostics', null)).schemaVersion).toBe(8);
      await close(page, 'after-rollback');
      host.checks.push('rolled-back marker is not a compatibility barrier; actual old worker reopens schema8 and preserves canonical/sync rows');

      await call(page, 'startMarker', 'marker', 'upgrade', { archiveId, mode: 'interrupt' }, 'interrupted');
      await wait(page, () => window.schema8Proof.events('marker').some(item => item.event === 'marker-transaction-open'));
      await call(page, 'kill', 'marker');
      await call(page, 'old', 'after-crash', archiveId);
      expect((await call(page, 'request', 'after-crash', 'diagnostics', null)).schemaVersion).toBe(8);
      await call(page, 'write', 'after-crash', 'old owner remains writable after uncommitted upgrade');
      await call(page, 'marker', 'marker2');
      await call(page, 'startMarker', 'marker2', 'upgrade', { archiveId, mode: 'hold' }, 'upgrade');
      await wait(page, async archiveId => (await navigator.locks.query()).pending.filter(item => item.name === `quixi:archive:${archiveId}:owner`).length === 1, archiveId);
      await call(page, 'old', 'waiter', archiveId);
      expect((await call(page, 'request', 'waiter', 'diagnostics', null)).schemaVersion).toBe(8);
      await wait(page, async archiveId => (await navigator.locks.query()).pending.filter(item => item.name === `quixi:archive:${archiveId}:owner`).length === 2, archiveId);
      await close(page, 'after-crash');
      await wait(page, () => window.schema8Proof.events('marker2').some(item => item.event === 'marker-committed-held'));
      const upgraded = (await call(page, 'events', 'marker2')).find(item => item.event === 'marker-committed-held');
      baseline = upgraded.after; expect(baseline.version).toBe(9); sameData(upgraded.before, baseline);
      expect(baseline.operations).toHaveLength(3);
      host.checks.push('actual marker worker termination inside transaction recovers schema8; old owner can still commit until future-version marker is durably committed');

      await call(page, 'queuedWrite', 'waiter', 'queued old waiter must not commit', 'waiter-write');
      expect((await call(page, 'job', 'waiter-write')).state).toBe('pending');
      await call(page, 'markerCall', 'marker2', 'release');
      await wait(page, () => window.schema8Proof.job('waiter-write')?.state !== 'pending');
      const failedWaiter = await call(page, 'job', 'waiter-write');
      expect(failedWaiter.state).toBe('failed'); expect(failedWaiter.error.code).toBe('MIGRATION_FAILED');
      host.errors.push(failedWaiter.error);
      await close(page, 'waiter');
      sameData(baseline, await call(page, 'markerCall', 'marker2', 'inspect', { archiveId }));
      host.checks.push('already-running old follower queued behind real owner lock becomes owner only after upgrade, then refuses before queued canonical mutation');

      await call(page, 'old', 'restarted-old', archiveId);
      host.errors.push(await refused(page, 'restarted-old', 'restart-write'));
      await close(page, 'restarted-old');
      sameData(baseline, await call(page, 'markerCall', 'marker2', 'inspect', { archiveId }));
      host.checks.push('fresh frozen old worker startup rejects schema9 with MIGRATION_FAILED, preserving exact canonical, sync and transaction rows');

      await call(page, 'old', 'candidate-owner', candidateId);
      await call(page, 'write', 'candidate-owner', 'retained candidate fixture');
      await call(page, 'kill', 'candidate-owner');
      const candidate = await call(page, 'markerCall', 'marker2', 'upgrade', { archiveId: candidateId });
      expect(candidate.after.version).toBe(9); sameData(candidate.before, candidate.after);
      await call(page, 'old', 'candidate-old-restart', candidateId);
      host.errors.push(await refused(page, 'candidate-old-restart', 'candidate-write'));
      await close(page, 'candidate-old-restart');
      sameData(candidate.after, await call(page, 'markerCall', 'marker2', 'inspect', { archiveId: candidateId }));
      host.checks.push('separate candidate namespace uses the same real owner lock; abrupt old owner termination permits marker, subsequent old startup refuses without data loss');
    } finally { await context.close(); }
    context = await engine.launchPersistentContext(profile, { headless: true });
    try {
      const page = await visit();
      await call(page, 'old', 'process-restart', archiveId);
      host.errors.push(await refused(page, 'process-restart', 'process-write'));
      await close(page, 'process-restart');
      await call(page, 'marker', 'inspect');
      const after = await call(page, 'markerCall', 'inspect', 'inspect', { archiveId });
      expect(after.version).toBe(9); sameData(baseline, after);
      host.snapshotSha256 = hash(JSON.stringify(after));
      host.checks.push('whole persistent browser-process restart retains schema9 barrier and exact committed canonical/sync rows with integrityok');
    } finally { await context.close(); }
    host.status = 'passed'; await save(); console.log(`${name}: frozen schema8 worker barrier passed ${host.checks.length} checks`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; console.error(report.error); }
finally { report.finishedAt = new Date().toISOString(); await save(); if (server) await new Promise(resolve => server.httpServer.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
