import { chromium, webkit, expect } from '@playwright/test';
import { browserEngines } from '../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir, platform, release, arch } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
const root = resolve(import.meta.dirname, '../../../..'), evidence = resolve(import.meta.dirname, 'evidence');
const engines = browserEngines({ chromium, webkit });
const report = { status: 'running', startedAt: new Date().toISOString(), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, selectedEngines: engines.map(([name]) => name), sourceSha256: {}, hosts: [] };
const hash = value => createHash('sha256').update(value).digest('hex');
const save = async () => { await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'browser-evidence.json'), JSON.stringify(report, null, 2) + '\n'); };
await save();
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-retained-extraction-')); let server;
const call = (page, method, ...args) => page.evaluate(({ method, args }) => window.extractionReceiptProof[method](...args), { method, args });
try {
  for (const file of ['packages/storage/src/client/reconcile-extraction.ts', 'packages/storage/src/client/retained-archive.ts', 'packages/storage/src/client/index.ts', 'packages/storage/src/worker/retained-archive.ts', 'packages/storage/src/worker/operation-claims.ts', 'packages/storage/src/worker/sqlite-module.ts', 'packages/storage/src/worker/archives/schema-validation.ts', 'packages/storage/src/worker/extraction/index.ts', 'packages/storage/src/worker/archive-database.ts', 'packages/storage/src/worker/archive-runtime.ts', 'packages/storage/src/worker/canonical/repository.ts', 'packages/storage/migrations/index.ts', 'packages/storage/migrations/operation-claims.ts', 'packages/storage/sqlite/dist/sqlite3.mjs', 'packages/storage/sqlite/dist/sqlite3.wasm', 'packages/storage/tests/retained/fixture-worker.mjs', 'packages/storage/tests/retained-extraction/index.mjs', 'packages/storage/tests/retained-extraction/fixture-worker.mjs', 'packages/storage/tests/retained-extraction/run.mjs']) report.sourceSha256[file] = hash(await readFile(resolve(root, file)));
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
      const page = await context.newPage(); page.setDefaultTimeout(30000);
      await page.goto(report.origin); await page.waitForFunction(() => !!window.extractionReceiptProof);
      host.userAgent = await page.evaluate(() => navigator.userAgent);
      const fixture = await call(page, 'seed'); host.fixture = fixture;
      expect((await call(page, 'sameSelection')).code).toBe('CONFLICT');
      expect((await call(page, 'diagnostics')).schemaVersion).toBe(13);
      host.checks.push('Same selected archive is refused before closing the actual managed client; client diagnostics remain usable');
      const activation = await call(page, 'activate'); host.activation = activation;
      expect(activation.selected.archiveId).not.toBe('default');
      const resolved = await call(page, 'reconcile'); expect(resolved).toEqual({ ok: true, result: 'committed' });
      const capture = await call(page, 'before'); expect(capture.closeCalls).toBe(1); expect(capture.files.length).toBeGreaterThan(0);
      const exact = await call(page, 'read', 'default', fixture.operationId);
      expect(exact.result).toEqual({ status: 'committed', requestDigest: fixture.requestDigest, result: fixture.result });
      expect(await call(page, 'selection')).toEqual(activation.selected);
      host.checks.push('Public upload/canonical document/extraction receipt survive real export, restore and managed activation; helper closes original client and checks its exact retained digest/result without retargeting');
      expect((await call(page, 'reconcile', fixture.operationId, 'f'.repeat(64))).code).toBe('UNKNOWN_OUTCOME');
      expect(await call(page, 'reconcile', randomUUID(), 'e'.repeat(64))).toEqual({ ok: true, result: 'not_committed' });
      expect((await call(page, 'read', 'default', fixture.canonicalId)).code).toBe('CONFLICT');
      expect((await call(page, 'read', activation.selected.archiveId, fixture.operationId)).result).toEqual({ status: 'not_found' });
      expect((await call(page, 'mutation')).code).toBe('INVALID_REQUEST');
      expect((await call(page, 'reconcile', fixture.operationId, 'invalid')).code).toBe('INVALID_REQUEST');
      expect(await call(page, 'snapshot', 'default')).toEqual(capture.files);
      host.checks.push('Expected-digest mismatch remains unknown; absent identity is not committed; wrong journal and writes are rejected; selected clean candidate has no old local receipt; every source file hash is unchanged');
      host.variants = [];
      for (const command of ['delete-receipt', 'drop-receipts', 'bad-digest', 'bad-result', 'large-result', 'orphan-receipt', 'other-domain', 'pre10-receipt', 'legacy8', 'legacy9']) {
        const variant = await call(page, 'variant', command); expect(variant.state.integrity).toBe('ok');
        const before = await call(page, 'snapshot', variant.archiveId);
        const result = await call(page, 'read', variant.archiveId, fixture.operationId);
        if (command.startsWith('legacy')) expect(result).toEqual({ ok: true, result: { status: 'not_found' } });
        else expect(result.code).toBe(command === 'other-domain' ? 'CONFLICT' : 'UNKNOWN_OUTCOME');
        expect(await call(page, 'snapshot', variant.archiveId)).toEqual(before);
        host.variants.push({ command, ...variant, result, files: before });
      }
      host.checks.push('Actual cloned SQLite variants preserve unknown outcomes for lost tables/receipts, mismatched digests, invalid/oversized JSON, orphan receipts and unfenced pre10 receipts; other domains conflict; genuine schema8/9 archives remain unmigrated and absent');
      expect(await call(page, 'selection')).toEqual(activation.selected);
      expect(await call(page, 'snapshot', 'default')).toEqual(capture.files);
      host.checks.push('Read/recovery variants preserve the literal original namespace, current selection and all source bytes');
      host.status = 'passed'; await save();
    } finally { await context.close(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); throw error; }
finally {
  report.completedAt = new Date().toISOString(); await save();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
