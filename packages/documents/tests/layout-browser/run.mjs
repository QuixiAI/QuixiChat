import { build } from 'vite';
import { chromium, webkit } from '@playwright/test';
import { browserEngines } from '../../../../tooling/browser-engines.mjs';
import { pdfAssetNotices } from '../../../../tooling/pdf-assets.ts';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = import.meta.dirname, root = resolve(here, '../../../..'), dist = resolve(here, 'build/dist');
const output = resolve(here, 'evidence/browser-evidence.json');
const selected = browserEngines({ chromium, webkit });
const sha = data => createHash('sha256').update(data).digest('hex');
const report = { status: 'running', startedAt: new Date().toISOString(), selectedEngines: selected.map(([name]) => name), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, sourceSha256: {}, hosts: [] };
const save = async () => { await mkdir(resolve(here, 'evidence'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
try {
  const old = await readFile(output);
  await mkdir(resolve(here, 'evidence/attempts'), { recursive: true });
  await writeFile(resolve(here, 'evidence/attempts', `${new Date().toISOString().replaceAll(':', '-')}-${sha(old).slice(0, 8)}.json`), old);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await save();
let server;
try {
  const files = [
    'package-lock.json', 'tooling/browser-engines.mjs', 'tooling/pdf-assets.ts',
    'packages/core/src/contracts/extraction.ts',
    'packages/documents/src/index.ts', 'packages/documents/src/contracts.ts', 'packages/documents/src/layout.ts',
    'packages/documents/src/worker/index.ts', 'packages/documents/src/worker/parser.ts', 'packages/documents/src/worker/assets.ts',
    'packages/documents/tooling/pdfjs-range-patch.mjs',
    'packages/documents/tests/fixtures/layout-manifest.json', 'packages/documents/tests/layout-fixtures.md',
    'packages/documents/tests/generate_layout_fixtures.py',
    ...['columns', 'table-code', 'unsupported'].map(name => `packages/documents/tests/fixtures/layout-${name}.pdf`),
    'node_modules/pdfjs-dist/build/pdf.mjs', 'node_modules/pdfjs-dist/build/pdf.worker.mjs', 'node_modules/pdfjs-dist/package.json',
    ...(await readdir(here, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => `packages/documents/tests/layout-browser/${entry.name}`),
  ];
  for (const file of files) report.sourceSha256[file] = sha(await readFile(resolve(root, file)));
  execFileSync(resolve(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', resolve(here, 'tsconfig.json')], { cwd: root, stdio: 'pipe' });
  await build({ configFile: false, root: here, plugins: [pdfAssetNotices()], logLevel: 'warn', worker: { format: 'es' }, build: { outDir: dist, emptyOutDir: true, assetsInlineLimit: 0 } });
  report.bundledSha256 = {};
  for (const name of await readdir(resolve(dist, 'assets'))) report.bundledSha256[`assets/${name}`] = sha(await readFile(resolve(dist, 'assets', name)));
  server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'");
    const path = request.url === '/' ? '/index.html' : request.url;
    if (!path || path.includes('..') || !/^\/[a-zA-Z0-9_./-]+$/.test(path)) { response.statusCode = 404; response.end(); return; }
    try {
      const bytes = await readFile(resolve(dist, '.' + path));
      const mime = { '.js': 'text/javascript', '.html': 'text/html', '.pdf': 'application/pdf', '.ttf': 'font/ttf' }[extname(path)];
      if (mime) response.setHeader('Content-Type', mime);
      response.end(bytes);
    } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [name, engine] of selected) {
    const entry = { engine: name, startedAt: new Date().toISOString(), status: 'running', requests: [], errors: [], external: [] };
    report.hosts.push(entry); await save();
    const process = await engine.launchServer({ headless: true });
    const browser = await engine.connect(process.wsEndpoint());
    entry.browserVersion = browser.version(); entry.processId = process.process().pid;
    try {
      const context = await browser.newContext();
      await context.route('**/*', async route => {
        const url = route.request().url();
        if (!url.startsWith(origin + '/')) { entry.external.push(url); await route.abort(); } else await route.continue();
      });
      context.on('request', request => entry.requests.push(request.url()));
      const page = await context.newPage();
      page.on('pageerror', error => entry.errors.push(String(error)));
      page.on('console', message => { if (message.type() === 'error') entry.errors.push(message.text()); });
      await page.goto(origin + '/');
      await page.waitForFunction(() => typeof globalThis.runLayoutProof === 'function', null, { timeout: 15000 });
      entry.proof = await Promise.race([page.evaluate(() => globalThis.runLayoutProof()), new Promise((_, reject) => setTimeout(() => reject(new Error('Layout proof exceeded90s deadline')), 90000).unref())]);
      if (entry.external.length || entry.errors.length) throw new Error(`External I/O or browser errors: ${JSON.stringify({ external: entry.external, errors: entry.errors })}`);
      entry.status = 'passed';
      console.log(`${name}: ${entry.proof.cases.length} authored PDFs / ${entry.proof.cases.reduce((count, value) => count + value.pages.length, 0)} page oracles passed`);
    } catch (error) { entry.status = 'failed'; entry.error = String(error.stack ?? error); }
    finally { await browser.close(); await process.close(); entry.completedAt = new Date().toISOString(); await save(); }
  }
  report.status = report.hosts.length === selected.length && report.hosts.every(host => host.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error);
  if (error.stdout) report.commandStdout = String(error.stdout).slice(-16000);
  if (error.stderr) report.commandStderr = String(error.stderr).slice(-16000);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  report.changedSources = [];
  for (const [file, expected] of Object.entries(report.sourceSha256)) if (sha(await readFile(resolve(root, file))) !== expected) report.changedSources.push(file);
  report.sourceStable = report.changedSources.length === 0;
  if (!report.sourceStable) report.status = 'failed';
  report.completedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ status: report.status, output, changedSources: report.changedSources }));
if (report.status !== 'passed') process.exitCode = 1;
