import { build } from 'vite';
import { createServer } from 'node:http';
import { chromium, webkit } from '@playwright/test';
import { browserEngines } from '../../../tooling/browser-engines.mjs';
const selectedEngines = browserEngines({ chromium, webkit });
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const dist = resolve(root, 'dist');
await build({ root, logLevel: 'warn', plugins: [{ name: 'retained-document-licenses', async generateBundle() { for (const name of await readdir(resolve(root, '../third-party'))) this.emitFile({ type: 'asset', fileName: `third-party/${name}`, source: await readFile(resolve(root, '../third-party', name)) }); } }], build: { outDir: dist, emptyOutDir: true, assetsInlineLimit: 0 }, worker: { format: 'es' } });
const server = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'");
  const path = req.url === '/' ? '/index.html' : req.url;
  if (!path || path.includes('..') || !/^\/[a-zA-Z0-9_./-]+$/.test(path)) { res.statusCode = 404; return res.end(); }
  try {
    const bytes = await readFile(resolve(path.startsWith('/fixtures/') ? root : dist, '.' + path));
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (path.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
    else if (path.endsWith('.html')) res.setHeader('Content-Type', 'text/html');
    if (match) { const start = Number(match[1]), end = Number(match[2]); res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`); res.end(bytes.subarray(start, end + 1)); }
    else res.end(bytes);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(4294, '127.0.0.1', resolve));
const results = [];
try {
  for (const [name, engine] of selectedEngines) {
    const browserServer = await engine.launchServer({ headless: true });
    const browser = await engine.connect(browserServer.wsEndpoint());
    const page = await browser.newPage(); const errors = []; const external = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    page.context().on('request', req => { if (!req.url().startsWith('http://127.0.0.1:4294/')) external.push(req.url()); });
    let activeMemory;
    let peakRssKiB = null, memoryUnavailable = null; const parent = browserServer.process().pid;
    const sample = () => {
      try {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      if (!rows.some(row => row[0] === parent) || rows.some(row => row.length !== 3 || !row.every(Number.isFinite))) throw new Error('Process tree not present or ps output unsupported.');
      const ids = new Set([parent]); let changed = true;
      while (changed) { changed = false; for (const [pid, ppid] of rows) if (ids.has(ppid) && !ids.has(pid)) { ids.add(pid); changed = true; } }
      const rss = rows.filter(row => ids.has(row[0])).reduce((sum, row) => sum + row[2], 0); peakRssKiB = Math.max(peakRssKiB ?? 0, rss); if (activeMemory) activeMemory.peakRssKiB = Math.max(activeMemory.peakRssKiB ?? 0, rss); return rss;
      } catch (e) { memoryUnavailable ??= `${process.platform}: ${String(e.message ?? e).slice(0, 500)}`; return null; }
    };
    await page.exposeFunction('measureDocumentMemory', (phase, name) => { if (phase === 'start') { const baselineRssKiB = sample(); activeMemory = { name, baselineRssKiB, peakRssKiB: baselineRssKiB }; return null; } sample(); const result = activeMemory; activeMemory = undefined; return result; });
    const baselineRssKiB = sample(); const timer = setInterval(sample, 200);
    try {
      await page.goto('http://127.0.0.1:4294/');
      await page.waitForFunction(() => typeof globalThis.runDocumentProof === 'function');
      const proof = await page.evaluate(() => globalThis.runDocumentProof());
      if (external.length) throw new Error(`External requests: ${external.join(',')}`);
      results.push({ engine: name, ...proof, baselineRssKiB, peakRssKiB, memoryUnavailable, externalRequests: external, consoleErrors: errors });
      console.log(`${name}: ${proof.checks.length} extraction checks passed`);
    } finally { clearInterval(timer); await browser.close(); await browserServer.close(); }
  }
  await mkdir(resolve(root, 'results'), { recursive: true });
  await writeFile(resolve(root, 'results/extraction-browser.json'), JSON.stringify({ createdAt: new Date().toISOString(), selectedEngines: selectedEngines.map(([name]) => name), platform: process.platform, arch: process.arch, memoryMeasurement: `200 ms ${process.platform} ps RSS samples of the browser-server process tree. Includes shared pages and excludes reparented or OS-managed processes; not an isolated parser heap measurement. Unavailable measurements are null with an explicit reason.`, pdfjs: '6.3.289', parserSha256: createHash('sha256').update(await readFile(require.resolve('pdfjs-dist/build/pdf.worker.mjs'))).digest('hex'), fixtures: JSON.parse(await readFile(resolve(root, 'fixtures/manifest.json'), 'utf8')), results }, null, 2) + '\n');
} finally { await new Promise(resolve => server.close(resolve)); }
