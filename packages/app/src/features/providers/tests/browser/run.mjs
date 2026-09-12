import { browserEngines } from '../../../../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { providerFixture } from '../../../../../../providers/tests/fixture-server.ts';
const selectedEngines = browserEngines({ chromium, webkit });
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-provider-settings-'));
let server;
const wire = [];
const fixture = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4196');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-api-key,anthropic-version');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const entry = { method: req.method, path: req.url, authorized: req.headers.authorization === 'Bearer synthetic-secret' || req.headers['x-api-key'] === 'synthetic-secret', body: null };
  wire.push(entry);
  const chunks = []; req.on('data', bytes => chunks.push(bytes)); req.on('end', () => { if (chunks.length) entry.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); });
  providerFixture(req, res);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const report = { selectedEngines: selectedEngines.map(([name]) => name), status: 'running', startedAt: new Date().toISOString(), scope: 'Real React provider settings/controller and production browser HostClient on synthetic loopback HTTP. Regional native capabilities are explicitly injected fixtures; native registration, physical geography and live account eligibility are not established by this browser proof.', hosts: [], sourceSha256: {} };
try {
  await mkdir('test-results', { recursive: true });
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: 'warn' });
  server = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: '127.0.0.1', port: 4196, strictPort: true }, logLevel: 'warn' });
  for (const [name, browser] of selectedEngines) {
    const context = await browser.launchPersistentContext(resolve(temporary, name), { headless: true, viewport: { width: 1100, height: 900 } });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const evidence = { name, status: 'running', checks: [], regionalRequests: [] }; report.hosts.push(evidence);
    const wireStart = wire.length;
    const cardFor = label => page.getByRole('article').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
    const expectPublished = async (id, expected) => expect.poll(() => page.evaluate(id => window.providerSetup.ids().includes(id), id)).toBe(expected);
    const eligibility = card => card.getByLabel('I confirmed this credential is eligible for regional processing', { exact: true });
    const images = card => card.getByLabel('I confirmed regional image-processing eligibility', { exact: true });
    try {
      await page.goto(`http://127.0.0.1:4196/?fixture=${encodeURIComponent(`http://127.0.0.1:${fixture.address().port}`)}`);
      await expect(page.getByText('Credentials stay in memory for this browser session. Reloading requires reconnecting.')).toBeVisible();
      for (const label of ['OpenAI', 'Anthropic']) {
        const card = cardFor(label);
        await card.getByLabel('API key', { exact: true }).fill('synthetic-secret'); await card.getByRole('button', { name: 'Connect credential', exact: true }).click();
        await expect(card.getByText('Credential connected · Connection not checked', { exact: true })).toBeVisible();
        await expect(card.getByLabel('API key', { exact: true })).toHaveValue('');
        await card.getByRole('button', { name: 'Check connection', exact: true }).click();
        await expect(card.getByText('Credential connected · healthy', { exact: true })).toBeVisible();
        await expect(card.locator('.quixi-provider-discovery')).toHaveText('Provider lists 3 models · 1 reviewed and selectable · 2 unreviewed: synthetic-model, unknown-model. Unreviewed models are not selectable until their capabilities and pricing are reviewed.');
        const stream = await page.evaluate(id => window.providerSetup.stream(id), label === 'OpenAI' ? 'openai' : 'anthropic');
        expect(stream.terminal).toBe('complete'); expect(stream.text).toContain('Hello 🧪');
      }
      evidence.checks.push('shared React settings connects both opaque session credentials and clears password inputs', 'actual production HostClient model probes and streams use the configured adapter instances', 'a connection check follows the Anthropic listing cursor to a second page and reports reviewed versus unreviewed models for both providers');
      expect(await page.evaluate(() => window.providerSetup.count())).toBe(2);
      const globalCard = cardFor('OpenAI'); const before = await page.evaluate(() => window.providerSetup.reopen('openai'));
      await globalCard.getByLabel('API key', { exact: true }).fill('synthetic-secret'); await globalCard.getByRole('button', { name: 'Replace credential' }).click();
      await expect(globalCard.getByText('Credential connected · Connection not checked', { exact: true })).toBeVisible();
      const after = await page.evaluate(() => window.providerSetup.reopen('openai')); expect(after.id).not.toBe(before.id);
      await globalCard.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(globalCard.getByText('No credential connected · Connection not checked', { exact: true })).toBeVisible(); expect(await page.evaluate(() => window.providerSetup.reopen('openai'))).toBeNull();
      evidence.checks.push('credential replacement rotates the handle; disconnect revokes its host association');

      for (const region of ['us', 'eu']) {
        const id = `openai-${region}`, card = cardFor(region === 'us' ? 'OpenAI · US' : 'OpenAI · Europe (EEA + Switzerland)');
        await card.getByLabel('API key', { exact: true }).fill('synthetic-secret'); await card.getByRole('button', { name: 'Connect credential', exact: true }).click();
        await expect(card.getByText('Credential connected · Connection not checked', { exact: true })).toBeVisible();
        await expect(eligibility(card)).not.toBeChecked(); await expect(images(card)).toBeDisabled(); await expectPublished(id, false);
        const probeStart = wire.length;
        await card.getByRole('button', { name: 'Check connection', exact: true }).click(); await expect(card.getByText('Credential connected · healthy', { exact: true })).toBeVisible();
        expect(wire.slice(probeStart).map(entry => [entry.method, entry.path])).toEqual([['GET', '/v1/models']]);
        await expect(eligibility(card)).not.toBeChecked(); await expectPublished(id, false);
        await eligibility(card).check(); await expectPublished(id, true);
        expect((await page.evaluate(id => window.providerSetup.model(id), id)).capabilities.images).toBe('unsupported');
        const imageDeniedStart = wire.length;
        expect(await page.evaluate(id => window.providerSetup.rejectedImage(id), id)).toBe(true);
        expect(wire.length).toBe(imageDeniedStart);
        const textStart = wire.length;
        const text = await page.evaluate(id => window.providerSetup.stream(id), id); expect(text.terminal).toBe('complete'); expect(text.text).toContain('Hello 🧪');
        const textWire = wire.slice(textStart); expect(textWire).toHaveLength(1);
        expect(textWire[0]).toMatchObject({ method: 'POST', path: '/v1/chat/completions', authorized: true, body: { model: 'gpt-4.1-mini-2025-04-14', max_completion_tokens: 100, stream: true } });
        const boundary = await page.evaluate(() => window.providerSetup.boundary());
        expect(boundary.at(-1)).toEqual({ binding: { providerId: 'openai', accountId: 'primary', destinationId: `quixi-openai-${region}-api-v1`, transportId: `quixi-openai-${region}-native-v1` }, path: '/v1/chat/completions', method: 'POST' });
        await images(card).check();
        await expect.poll(() => page.evaluate(id => window.providerSetup.model(id)?.capabilities.images, id)).toBe('supported');
        const imageStart = wire.length; const imageResult = await page.evaluate(id => window.providerSetup.stream(id, true), id); expect(imageResult.terminal).toBe('complete');
        const imageWire = wire.slice(imageStart); expect(imageWire).toHaveLength(1);
        expect(imageWire[0].body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
        evidence.regionalRequests.push({ region, text: textWire[0], image: imageWire[0], binding: boundary.at(-1).binding });
        await page.evaluate(id => window.providerSetup.capture(id), id); const revokeStart = wire.length;
        await eligibility(card).uncheck(); await expectPublished(id, false);
        expect(await page.evaluate(id => window.providerSetup.retainedRefusals(id), id)).toEqual({ prepare: true, countTokens: true, stream: true }); expect(wire.length).toBe(revokeStart);
        await eligibility(card).check(); await expectPublished(id, true); await page.evaluate(id => window.providerSetup.capture(id), id);
        await card.getByRole('button', { name: 'Reopen connection', exact: true }).click(); await expect(eligibility(card)).not.toBeChecked(); await expectPublished(id, false);
        expect(await page.evaluate(id => window.providerSetup.retainedRefusals(id), id)).toEqual({ prepare: true, countTokens: true, stream: true });
        await eligibility(card).check(); await expectPublished(id, true); const old = await page.evaluate(id => window.providerSetup.reopen(id), id); await page.evaluate(id => window.providerSetup.capture(id), id);
        await card.getByLabel('API key', { exact: true }).fill('synthetic-secret'); await card.getByRole('button', { name: 'Replace credential', exact: true }).click();
        await expect(eligibility(card)).not.toBeChecked(); await expectPublished(id, false);
        const replacement = await page.evaluate(id => window.providerSetup.reopen(id), id); expect(replacement.id).not.toBe(old.id);
        expect(await page.evaluate(id => window.providerSetup.retainedRefusals(id), id)).toEqual({ prepare: true, countTokens: true, stream: true });
        await eligibility(card).check(); await expectPublished(id, true);
        await page.evaluate(id => window.providerSetup.setInvalidMetadata(id, true), id); const invalidStart = wire.length;
        await card.getByRole('button', { name: 'Reopen connection', exact: true }).click();
        await expect(card.getByText('The host has no matching reviewed regional route for this connection.', { exact: true })).toBeVisible();
        await expect(eligibility(card)).toBeDisabled(); await expectPublished(id, false); expect(wire.length).toBe(invalidStart);
        await page.evaluate(id => window.providerSetup.setInvalidMetadata(id, false), id);
        await card.getByRole('button', { name: 'Reopen connection', exact: true }).click(); await expect(eligibility(card)).toBeEnabled(); await eligibility(card).check(); await expectPublished(id, true);
        await images(card).check(); await expect(images(card)).toBeChecked();
        await card.locator('summary').click(); await expect(card.getByText(/Reviewed model: gpt-4.1-mini-2025-04-14/)).toBeVisible();
      }
      evidence.checks.push('US and EU credentials remain unpublished until explicit eligibility confirmation; successful model probes cannot confirm eligibility', 'confirmed regional text streams preserve exact reviewed model and regional binding; images refuse until separately confirmed and then reach the synthetic wire', 'revoking eligibility invalidates retained adapter prepare, count and stream methods before any HTTP request', 'reopening and replacing either regional credential clear confirmation and invalidate old adapter references', 'a mismatched regional capability binding disables the connection and refuses publication before HTTP');
      await page.screenshot({ path: `test-results/provider-settings-regions-${name}-desktop.png`, fullPage: true });
      await cardFor('OpenAI · Europe (EEA + Switzerland)').screenshot({ path: `test-results/provider-settings-regions-${name}-detail-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/provider-settings-regions-${name}-mobile.png`, fullPage: true });
      await cardFor('OpenAI · Europe (EEA + Switzerland)').screenshot({ path: `test-results/provider-settings-regions-${name}-detail-mobile.png` });
      evidence.checks.push('expanded regional details, eligibility controls and provider limits fit desktop and 390-pixel viewports without horizontal overflow');
      await page.reload(); await expect(page.getByText('No credential connected · Connection not checked', { exact: true })).toHaveCount(4);
      expect(await page.evaluate(() => window.providerSetup.count())).toBe(0);
      for (const label of ['OpenAI · US', 'OpenAI · Europe (EEA + Switzerland)']) { const card = cardFor(label); await expect(eligibility(card)).not.toBeChecked(); await expect(images(card)).not.toBeChecked(); await expect(eligibility(card)).toBeDisabled(); }
      evidence.checks.push('actual reload loses all browser credentials, regional eligibility confirmations and configured adapters');
      await page.screenshot({ path: `test-results/provider-settings-${name}.png`, fullPage: true });
      evidence.userAgent = await page.evaluate(() => navigator.userAgent); evidence.httpRequests = wire.slice(wireStart).length;
      expect(wire.slice(wireStart)).toHaveLength(11);
      expect(wire.slice(wireStart).every(entry => entry.authorized)).toBe(true); expect(errors).toEqual([]);
      await page.evaluate(() => window.providerSetup.close()); evidence.status = 'passed';
    } finally { await context.close(); }
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack ?? error); process.exitCode = 1; }
finally {
  for (const file of ['tooling/browser-engines.mjs', 'packages/core/src/contracts/host.ts', 'packages/app/src/features/providers/controller.ts', 'packages/app/src/features/providers/types.ts', 'packages/app/src/features/providers/ProviderSettingsPanel.tsx', 'packages/app/src/features/providers/providers.css', 'packages/providers/src/catalog.ts', 'packages/providers/src/regional.ts', 'packages/providers/src/adapter.ts', 'packages/providers/src/request.ts', 'apps/web/src/host/regional-relay.ts', 'apps/web/src/host/index.ts', 'packages/providers/tests/fixture-server.ts', 'packages/app/src/features/providers/tests/browser/index.tsx', 'packages/app/src/features/providers/tests/browser/index.html', 'packages/app/src/features/providers/tests/browser/run.mjs']) report.sourceSha256[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  report.finishedAt = new Date().toISOString(); await mkdir('test-results', { recursive: true }); await writeFile('test-results/provider-settings-browser.json', JSON.stringify(report, null, 2) + '\n');
  await server?.httpServer.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await rm(temporary, { recursive: true, force: true }); console.log(JSON.stringify(report, null, 2));
}
