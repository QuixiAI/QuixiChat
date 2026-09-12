import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const results = resolve(directory, 'results');
await mkdir(results, { recursive: true });
const startedAt = new Date().toISOString();
const reportPath = resolve(results, 'registry-wasm.json');
await writeFile(reportPath, JSON.stringify({ startedAt, status: 'in_progress' }, null, 2) + '\n');
await writeFile(resolve(results, 'registry.tap'), '');
try {
  const tests = (await readdir(directory)).filter(name => name.endsWith('.test.ts')).sort().map(name => resolve(directory, name));
  if (!tests.length) throw new Error('No operation-claim tests found.');
  const command = ['--experimental-transform-types', '--test', '--test-reporter=tap', ...tests];
  const run = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
  const tap = run.stdout ?? '';
  const number = name => Number(new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap)?.[1] ?? 0);
  const migrationLine = /^# claims-migration (.+)$/m.exec(tap)?.[1];
  const files = [
    'packages/storage/migrations/operation-claims.ts', 'packages/storage/migrations/index.ts',
    'packages/storage/src/worker/operation-claims.ts', 'packages/storage/src/worker/archive-operation-fences.ts',
    'packages/storage/src/worker/canonical/repository.ts', 'packages/storage/src/worker/archives/clean-copy.ts',
    'packages/storage/src/worker/archives/validation.ts', 'packages/storage/src/worker/archives/schema-validation.ts',
    'packages/storage/src/worker/archives/snapshot.ts', 'packages/storage/src/worker/archives/format.ts',
    'packages/storage/src/worker/extraction/index.ts', 'packages/storage/src/worker/extraction/schema.ts',
    'packages/core/src/contracts/extraction.ts', 'packages/storage/tests/operation-claims/registry.test.ts',
    'packages/storage/tests/operation-claims/run.mjs', 'packages/storage/tests/operation-claims/tsconfig.json',
    'packages/storage/sqlite/artifacts.json', 'packages/storage/sqlite/dist/sqlite3.mjs', 'packages/storage/sqlite/dist/sqlite3.wasm',
  ];
  const sourceHashes = {};
  for (const file of files) sourceHashes[file] = createHash('sha256').update(await readFile(resolve(root, file))).digest('hex');
  const result = {
    startedAt, completedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    status: run.status === 0 && number('tests') > 0 ? 'passed' : 'failed', exitCode: run.status, signal: run.signal,
    command: [process.execPath, ...command], error: run.error ? String(run.error) : null,
    tests: number('tests'), passed: number('pass'), failed: number('fail'),
    migration: migrationLine ? JSON.parse(migrationLine) : null, sourceHashes,
    evidenceScope: 'Pinned SQLite WASM in Node memory VFS: actual canonical/extraction repositories, SQL transactions, page-limit FULL, close/reopen and clean-copy. No browser, OPFS, process-crash or public dispatcher integration claim.',
  };
  await writeFile(resolve(results, 'registry.tap'), tap + (run.stderr ?? ''));
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'passed') process.exitCode = run.status || 1;
} catch (error) {
  await writeFile(reportPath, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), status: 'failed', error: String(error) }, null, 2) + '\n');
  throw error;
}
