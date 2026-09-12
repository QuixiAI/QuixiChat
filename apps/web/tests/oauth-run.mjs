import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { chromium, webkit } from '@playwright/test';
import { browserNames } from '../../../tooling/browser-engines.mjs';

const root = resolve(import.meta.dirname, '../../..'), output = resolve(root, 'test-results/web-oauth-browser.json');
const report = { status: 'running', startedAt: new Date().toISOString(), expectedGroupsPerEngine: 22, scope: 'Real production browser HostClient, explicit user click, cross-origin synthetic authorization navigation and built callback under production COOP/COEP/CSP/referrer/cache headers. Main fixture uses only production COOP/COEP. Real CORS token POST with PKCE and session-handle provider HTTP on explicitly allowed loopback HTTP origins. No real provider, external account, TLS deployment, persisted OAuth session, or native Keychain claim. Negative-only popup/BroadcastChannel/isolation faults are identified by their test names. History navigation records actual restoration observations; no BFCache claim without a persisted pageshow observation.', engines: {}, commands: [], groups: [], sourceSha256: {}, changedSources: [] };
let leaked = false;
function redact(text) {
  return text.replace(/(?:synthetic-(?:access|code)-[0-9a-f-]{36}|(?:state|code|code_verifier|access_token|refresh_token|id_token)=[^&\s"<>\\]+|quixi-oauth-v1:[A-Za-z0-9_-]{43})/g, () => { leaked = true; return '[redacted synthetic OAuth value]'; });
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(folder) { const result = []; for (const item of await readdir(resolve(root, folder), { withFileTypes: true })) { const path = folder + '/' + item.name; if (item.isDirectory()) result.push(...await files(path)); else result.push(path); } return result; }
async function command(argv) {
  const startedAt = new Date().toISOString(); let stdout = '', stderr = '';
  const child = spawn(argv[0], argv.slice(1), { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-32768); }); child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-32768); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 480000);
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); }); clearTimeout(timer);
  report.commands.push({ argv, startedAt, completedAt: new Date().toISOString(), exitCode, stdout: redact(stdout), stderr: redact(stderr) });
  return exitCode;
}
try {
  const roots = ['apps/web/src/host', 'packages/core/src/contracts', 'packages/core/src/model', 'packages/providers/src'];
  const sources = ['package.json', 'package-lock.json', '.github/workflows/check.yml', 'apps/web/package.json', 'apps/web/vite.config.ts', 'deploy/docker/nginx.conf', 'apps/web/oauth/callback.html', 'apps/web/src/oauth-callback.ts', 'tooling/vite.ts', 'tooling/pdf-assets.ts', 'tooling/browser-engines.mjs', ...await files('apps/web/tests').then(values => values.filter(value => /\/oauth[^/]*\.(?:ts|mjs|html)$/.test(value))), ...await Promise.all(roots.map(files)).then(values => values.flat().filter(value => value.endsWith('.ts')))];
  for (const path of [...new Set(sources)].sort()) report.sourceSha256[path] = sha(await readFile(resolve(root, path)));
  for (const name of browserNames()) { const browser = await ({ chromium, webkit })[name].launch({ headless: true }); report.engines[name] = { browserVersion: browser.version() }; await browser.close(); }
  if (await command(['npm', 'run', 'build', '--workspace', '@quixi/web'])) throw new Error('Production web/callback build failed');
  report.callbackArtifacts = {};
  for (const path of (await files('apps/web/dist')).filter(value => value.endsWith('/oauth/callback.html') || /\/assets\/(?:oauthCallback|modulepreload-polyfill)-[^/]+\.js$/.test(value))) report.callbackArtifacts[relative('apps/web/dist', path)] = sha(await readFile(resolve(root, path)));
  const exitCode = await command(['node_modules/.bin/playwright', 'test', '-c', 'apps/web/tests/oauth-playwright.config.ts']);
  const rawText = await readFile(resolve(root, 'test-results/web-oauth-playwright.json'), 'utf8');
  const redactedRaw = redact(rawText);
  if (rawText !== redactedRaw) await writeFile(resolve(root, 'test-results/web-oauth-playwright.json'), redactedRaw);
  const raw = JSON.parse(redactedRaw);
  function visit(suite) {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const last = test.results.at(-1);
      const wire = (last?.attachments ?? []).filter(value => value.name === 'redacted-wire').map(value => JSON.parse(Buffer.from(value.body, 'base64').toString()));
      const lifecycle = (last?.attachments ?? []).filter(value => value.name === 'history-lifecycle').map(value => JSON.parse(Buffer.from(value.body, 'base64').toString()));
      report.groups.push({ engine: test.projectName, name: spec.title, status: last?.status, durationMs: last?.duration, wire, lifecycle, errors: (last?.errors ?? []).map(value => redact(value.message ?? 'Browser assertion failed')) });
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of raw.suites ?? []) visit(suite);
  report.fixtureArtifacts = {};
  for (const path of await files('test-results/web-oauth-fixture')) report.fixtureArtifacts[relative('test-results/web-oauth-fixture', path)] = sha(await readFile(resolve(root, path)));
  report.status = exitCode === 0 && report.groups.every(value => value.status === 'passed') && browserNames().every(name => report.groups.filter(value => value.engine === name).length === report.expectedGroupsPerEngine) ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = redact(String(error)); }
finally {
  for (const [path, expected] of Object.entries(report.sourceSha256)) if (sha(await readFile(resolve(root, path))) !== expected) report.changedSources.push(path);
  if (report.changedSources.length || leaked) report.status = 'failed';
  report.sensitiveOutputDetected = leaked; report.completedAt = new Date().toISOString();
  await mkdir(resolve(root, 'test-results/web-oauth-attempts'), { recursive: true });
  const bytes = JSON.stringify(report, null, 2) + '\n'; await writeFile(output, bytes); await writeFile(resolve(root, 'test-results/web-oauth-attempts', report.startedAt.replaceAll(':', '-') + '.json'), bytes);
  console.log(JSON.stringify({ status: report.status, engines: Object.keys(report.engines), groups: report.groups.length, sourceHashes: Object.keys(report.sourceSha256).length, output, error: report.error }, null, 2));
}
if (report.status !== 'passed') process.exitCode = 1;
