import { browserEngines } from '../../../../../tooling/browser-engines.mjs';
import { build, preview } from 'vite';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, release, arch } from 'node:os';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { regionalRelayFixture } from '../../../../../apps/relay/tests/regional-fixture.mjs';

const selected = browserEngines({ chromium, webkit });
const temporary = await mkdtemp(resolve(tmpdir(), 'quixi-app-regional-relay-'));
const appOrigin = 'http://127.0.0.1:4198';
const proof = { status: 'running', startedAt: new Date().toISOString(), selectedEngines: selected.map(([name]) => name), environment: { platform: platform(), release: release(), arch: arch(), node: process.version }, scope: 'Production configuredWebProviders, browser HostClient, AppRoot/settings/workflows and real relay server with controlled regional-hostname HTTPS upstream. No native capability injection, live provider account, physical geography or model-quality claim. Browser ignores the self-signed test relay certificate; relay-to-upstream TLS validates its ephemeral CA and original regional hostname. Negative-only metadata corruption is explicitly identified.', hosts: [], sourceSha256: {} };
let previewServer, activeConfiguration;
const sourceFiles = [
  'packages/app/tests/browser/relay/index.html', 'packages/app/tests/browser/relay/index.ts', 'packages/app/tests/browser/relay/run.mjs',
  'apps/relay/tests/regional-fixture.mjs', 'apps/relay/tests/fixture.mjs', 'apps/relay/src/server.mjs', 'apps/relay/src/config.mjs', 'apps/relay/src/policy.mjs',
  'apps/web/src/configuration.ts', 'apps/web/src/host/provider-connections.ts', 'apps/web/src/host/index.ts', 'apps/web/src/host/regional-relay.ts',
  'packages/core/src/contracts/host.ts', 'packages/core/src/contracts/routing-aliases.ts', 'packages/providers/src/regional.ts', 'packages/providers/src/catalog.ts',
  'packages/providers/src/request.ts', 'packages/providers/src/generation.ts', 'packages/providers/src/adapter.ts', 'packages/providers/src/types.ts',
  'packages/app/src/AppRoot.tsx', 'packages/app/src/styles.css', 'packages/app/src/workflows/chat.ts', 'packages/app/src/runtime/library.ts',
  'packages/app/src/runtime/routing.ts', 'packages/app/src/runtime/processing-region.ts', 'packages/app/src/runtime/request-cost.ts',
  'packages/app/src/features/providers/controller.ts', 'packages/app/src/features/providers/ProviderSettingsPanel.tsx', 'packages/app/src/features/providers/types.ts',
  'packages/app/src/features/compaction/summaries.ts', 'packages/app/src/features/compaction/SummaryCompaction.tsx',
  'packages/storage/tests/isolated-client.ts', 'packages/storage/tests/isolated-worker.ts', 'packages/storage/src/worker/canonical/repository.ts',
  'tooling/browser-engines.mjs', 'package-lock.json',
];
const save = async () => { await mkdir('test-results', { recursive: true }); await writeFile('test-results/app-regional-relay-browser.json', JSON.stringify(proof, null, 2) + '\n'); };
const records = (page, collection) => page.evaluate(collection => window.regionalRelayAcceptance.records(collection), collection);
const regionalCard = page => page.getByRole('article').filter({ has: page.getByLabel('I confirmed this credential is eligible for regional processing', { exact: true }) });
const eligibility = card => card.getByLabel('I confirmed this credential is eligible for regional processing', { exact: true });
const contentCalls = traffic => traffic.filter(entry => entry.path === '/v1/provider-http' && entry.method === 'POST' && entry.providerMethod === 'POST');
const send = async (page, text) => {
  await page.getByLabel('Message', { exact: true }).fill(text);
  if (await page.locator('.switch-report').count()) await page.getByRole('checkbox', { name: /I reviewed this switch/ }).check();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
};
try {
  for (const file of sourceFiles) proof.sourceSha256[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  const outDir = resolve(temporary, 'dist');
  await build({ configFile: false, root: import.meta.dirname, build: { outDir, emptyOutDir: true }, logLevel: 'warn' });
  previewServer = await preview({ configFile: false, root: import.meta.dirname, build: { outDir }, preview: { host: '127.0.0.1', port: 4198, strictPort: true }, logLevel: 'warn', plugins: [{ name: 'regional-relay-fixture-configuration', configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url, appOrigin); if (url.pathname !== '/fixture-configuration') return next();
      const config = structuredClone(activeConfiguration), variant = url.searchParams.get('case');
      if (variant === 'identity') config.regional[0].configurationId = '0'.repeat(64);
      if (variant === 'region') config.regional[0].region = 'eu';
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(config));
    });
  } }] });
  for (const [name, engine] of selected) {
    const evidence = { name, status: 'running', checks: [], traffic: [], negativeCases: [] }; proof.hosts.push(evidence);
    let corruptMetadata = null, metadataGate = null, context;
    const fixture = await regionalRelayFixture({ region: 'us', allowedOrigins: [appOrigin], async onUpstream(req, res, entry) {
      expect(req.headers.authorization).toBe('Bearer synthetic-secret');
      expect(req.headers.host).toBe('us.api.openai.com');
      expect(req.headers['x-quixi-configuration']).toBeUndefined(); expect(req.headers['x-quixi-provider-authorization']).toBeUndefined();
      if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4.1-mini-2025-04-14', object: 'model' }] })); return; }
      expect(req.url).toBe('/v1/chat/completions'); const body = JSON.parse(entry.body.toString()); expect(body.model).toBe('gpt-4.1-mini-2025-04-14');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const prefix = { id: 'synthetic-regional-relay', object: 'chat.completion.chunk', model: body.model };
      res.write(`data: ${JSON.stringify({ ...prefix, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic regional relay answer.' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...prefix, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } });
    fixture.frontServer.prependListener('request', (req, res) => {
      const entry = { path: req.url, method: req.method, headerNames: Object.keys(req.headers), destinationId: req.headers['x-quixi-destination'] ?? null, configurationId: req.headers['x-quixi-configuration'] ?? null, providerMethod: req.headers['x-quixi-method'] ?? null, providerPath: req.headers['x-quixi-path'] ?? null, status: null, corruptedMetadata: corruptMetadata };
      evidence.traffic.push(entry); res.on('finish', () => { entry.status = res.statusCode; });
      if (req.url === '/v1/regional-configuration' && req.method === 'POST') {
        // Controlled negative protocol responses and a scheduling gate, never
        // injected HostCapabilities or replacement production dispatch code.
        const end = res.end;
        res.end = function (data, ...rest) {
          if (res.statusCode === 200 && data && corruptMetadata) {
            const body = JSON.parse(Buffer.from(data).toString());
            if (corruptMetadata === 'upstream') body.upstreamOrigin = 'https://eu.api.openai.com';
            if (corruptMetadata === 'identity') body.configurationId = '0'.repeat(64);
            res.removeHeader('content-length'); data = JSON.stringify(body);
          }
          if (res.statusCode === 200 && metadataGate) {
            const gate = metadataGate;
            void records(gate.page, 'generations').then(attempts => {
              if (metadataGate === gate && attempts.length >= gate.attemptCount && attempts.some(attempt => attempt.status === 'streaming')) {
                gate.releases.push(() => end.call(this, data, ...rest));
                entry.heldForCanonicalPolicyMutation = true;
              } else end.call(this, data, ...rest);
            }).catch(() => end.call(this, data, ...rest));
            return this;
          }
          return end.call(this, data, ...rest);
        };
      }
    });
    const declaration = fixture.declaration;
    activeConfiguration = { origin: fixture.httpsRelayOrigin, operator: declaration.operator, privacy: 'self_hosted_remote', destinations: { openai: 'unused-global-openai', anthropic: 'unused-global-anthropic' }, regional: [{ region: 'us', destinationId: declaration.destinationId, configurationId: declaration.configurationId }] };
    const profile = resolve(temporary, name), archive = `test-relay-${randomUUID()}`, url = `${appOrigin}/?archive=${archive}`;
    const browserRequests = [], pageErrors = [];
    const newContext = async (path = profile) => engine.launchPersistentContext(path, { headless: true, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
    const newPage = async value => { const page = await value.newPage(); page.on('request', request => browserRequests.push(request.url())); page.on('pageerror', error => pageErrors.push(String(error))); return page; };
    try {
      context = await newContext(); let page = await newPage(context); await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible();
      await page.getByRole('button', { name: 'Providers', exact: true }).click(); const card = regionalCard(page);
      await expect(card).toHaveCount(1); await expect(eligibility(card)).toBeDisabled();
      expect(evidence.traffic.filter(entry => entry.method === 'POST')).toHaveLength(0);
      await card.getByLabel('Relay authorization token', { exact: true }).fill(fixture.token);
      await card.getByRole('button', { name: 'Authorize relay', exact: true }).click();
      await expect(card.getByLabel('Relay authorization token', { exact: true })).toHaveValue('');
      await expect.poll(async () => (await page.evaluate(() => window.regionalRelayAcceptance.capabilities())).providerTransports.find(value => value.regionalProcessing)?.capability.available).toBe(true);
      const transport = (await page.evaluate(() => window.regionalRelayAcceptance.capabilities())).providerTransports.find(value => value.regionalProcessing);
      expect(transport).toMatchObject({ kind: 'relay', privacy: 'self_hosted_remote', endpointOrigin: fixture.httpsRelayOrigin, relayIdentity: declaration.operator, regionalProcessing: { region: 'us', upstreamOrigin: 'https://us.api.openai.com', relay: { configurationId: declaration.configurationId, origin: fixture.httpsRelayOrigin, operator: declaration.operator, destinationId: declaration.destinationId, region: 'us' } } });
      await card.getByLabel('API key', { exact: true }).fill('synthetic-secret'); await card.getByRole('button', { name: 'Connect credential', exact: true }).click();
      await expect(card.getByText('Credential connected · Connection not checked', { exact: true })).toBeVisible();
      await expect(eligibility(card)).not.toBeChecked();
      await page.evaluate(() => window.regionalRelayAcceptance.mutateReturnedCapabilities());
      await card.getByRole('button', { name: 'Check connection', exact: true }).click(); await expect(card.getByText('Credential connected · healthy', { exact: true })).toBeVisible();
      await expect(eligibility(card)).not.toBeChecked(); expect(fixture.received).toHaveLength(1); expect(fixture.received[0].path).toBe('/v1/models'); expect(contentCalls(evidence.traffic)).toHaveLength(0);
      const afterMutation = (await page.evaluate(() => window.regionalRelayAcceptance.capabilities())).providerTransports.find(value => value.regionalProcessing);
      expect(afterMutation.regionalProcessing.relay.configurationId).toBe(declaration.configurationId); expect(afterMutation.endpointOrigin).toBe(fixture.httpsRelayOrigin);
      // The real relay requires an asynchronous metadata check before confirming.
      await eligibility(card).click(); await expect(eligibility(card)).toBeChecked(); await expect(card.getByText('Eligibility: user-confirmed for text.', { exact: true })).toBeVisible();
      await card.screenshot({ path: `test-results/regional-relay-${name}-connection.png` });
      evidence.checks.push('real authenticated relay declaration admits exact operator, region, upstream and configuration identity through the unmodified production browser host', 'mutating returned regional capability objects cannot redirect metadata/content or replace the pinned configuration; actual model discovery still uses the original relay', 'model discovery and relay authentication do not confirm credential eligibility; explicit account confirmation enables the regional connection while image eligibility remains separate');
      await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      await page.getByText('Conversation settings', { exact: true }).click(); await page.getByLabel('Title', { exact: true }).fill('Regional relay notebook'); await page.getByRole('button', { name: 'Rename', exact: true }).click();
      await page.getByLabel('Provider', { exact: true }).selectOption('openai-us-relay'); await page.getByLabel('Maximum output tokens', { exact: true }).fill('128');
      await page.getByLabel('Required processing region', { exact: true }).selectOption('us');
      await expect.poll(async () => (await records(page, 'threadStates'))[0]?.routingProfile?.requirements.processingRegion).toBe('us');
      await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeDisabled();
      const attempts = async () => (await records(page, 'generations')).sort((left, right) => left.createdAt - right.createdAt);
      await send(page, 'Synthetic first regional relay question.'); await expect.poll(async () => (await attempts()).at(-1)?.status).toBe('complete');
      await send(page, 'Synthetic second regional relay question.'); await expect.poll(async () => (await attempts()).filter(value => value.status === 'complete').length).toBe(2);
      expect(contentCalls(evidence.traffic)).toHaveLength(2);
      const summary = page.getByRole('region', { name: 'Conversation summary', exact: true });
      await summary.getByRole('button', { name: 'Review conversation summaries', exact: true }).click(); await summary.getByRole('button', { name: 'Prepare summary request', exact: true }).click();
      const review = summary.getByRole('region', { name: 'Review summary request', exact: true });
      await review.getByRole('checkbox', { name: 'I reviewed this summary request and its destination', exact: true }).check(); await expect(review).toContainText(declaration.configurationId);
      await review.getByRole('button', { name: 'Generate summary proposal', exact: true }).click(); await expect(summary.getByLabel('Reviewed summary', { exact: true })).toBeEnabled({ timeout: 15000 });
      const proposal = (await records(page, 'summaryProposals'))[0]; expect(proposal.inputSha256).toBe(createHash('sha256').update(fixture.received.at(-1).body).digest('hex'));
      await summary.getByRole('button', { name: 'Close summary review', exact: true }).click();
      await expect(page.locator('.switch-report')).toHaveCount(0);
      await page.getByRole('button', { name: /^Generate another response — / }).first().click(); await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
      await expect.poll(async () => (await attempts()).filter(value => value.status === 'complete').length).toBe(4);
      expect(contentCalls(evidence.traffic)).toHaveLength(4);
      for (const attempt of await attempts()) { expect(attempt.provider).toBe('openai'); expect(attempt.model).toBe('gpt-4.1-mini-2025-04-14'); expect(JSON.stringify(attempt.compatibility)).toContain(declaration.configurationId); }
      for (const request of fixture.received.filter(entry => entry.path === '/v1/chat/completions')) expect(JSON.parse(request.body.toString())).toMatchObject({ model: 'gpt-4.1-mini-2025-04-14', max_completion_tokens: 128, store: false });
      expect(contentCalls(evidence.traffic).every(entry => entry.configurationId === declaration.configurationId)).toBe(true);
      evidence.checks.push('actual AppRoot sends and regeneration cross the real relay into hostname-verified regional TLS upstream and persist complete canonical attempts with pinned relay review basis', 'regional summary generation crosses the same real relay, preserves output parameters, and its durable frozen-input hash equals the exact upstream bytes');
      const beforeMismatch = contentCalls(evidence.traffic).length, beforeUpstream = fixture.received.length;
      corruptMetadata = 'upstream'; await send(page, 'Synthetic content must not leave when relay metadata changes.');
      await expect.poll(async () => (await attempts()).at(-1)?.status).toBe('failed');
      expect(contentCalls(evidence.traffic)).toHaveLength(beforeMismatch); expect(fixture.received).toHaveLength(beforeUpstream);
      corruptMetadata = null;
      evidence.checks.push('changing the authenticated upstream declaration after prior successful generations is refused by a fresh final host check, leaving a durable failed attempt but zero additional content HTTP to relay or upstream');
      const gate = { page, attemptCount: 6, releases: [] }; metadataGate = gate;
      await page.getByLabel('Message', { exact: true }).fill('Synthetic content must not leave after policy changes during relay verification.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => gate.releases.length).toBeGreaterThan(0);
      await expect.poll(async () => (await attempts()).at(-1)?.status).toBe('streaming');
      await page.evaluate(() => window.regionalRelayAcceptance.setStoredProcessingRegion('eu'));
      expect((await records(page, 'threadStates'))[0].routingProfile.requirements.processingRegion).toBe('eu');
      metadataGate = null; for (const release of gate.releases) release();
      await expect.poll(async () => (await attempts()).at(-1)?.status).toBe('failed');
      expect(contentCalls(evidence.traffic)).toHaveLength(beforeMismatch); expect(fixture.received).toHaveLength(beforeUpstream);
      await expect(page.getByLabel('Required processing region', { exact: true })).toHaveValue('eu');
      await page.getByLabel('Required processing region', { exact: true }).selectOption('us');
      await expect.poll(async () => (await records(page, 'threadStates'))[0].routingProfile.requirements.processingRegion).toBe('us');
      evidence.checks.push('changing canonical processing policy from US to EU while a successful relay metadata response is held triggers the post-handshake guard: the durable attempt fails with zero additional content HTTP or upstream requests');
      const savedState = (await records(page, 'threadStates'))[0], savedAttempts = await attempts();
      const persisted = JSON.stringify({ state: savedState, generations: savedAttempts, messages: await records(page, 'messages'), proposals: await records(page, 'summaryProposals'), events: await records(page, 'events') });
      expect(persisted).not.toContain(fixture.token); expect(persisted).not.toContain('synthetic-secret'); expect(await page.locator('body').innerText()).not.toContain(fixture.token);
      expect(browserRequests.some(value => value.includes('unregistered.invalid'))).toBe(false);
      await page.getByLabel('Required processing region', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/regional-relay-${name}-conversation.png`, fullPage: true });
      await page.evaluate(() => window.regionalRelayAcceptance.close()); await context.close(); context = await newContext(); page = await newPage(context); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(url);
      await page.getByRole('button', { name: 'Regional relay notebook', exact: true }).click();
      expect((await records(page, 'threadStates'))[0].routingProfile).toEqual(savedState.routingProfile); expect(await records(page, 'generations')).toHaveLength(6);
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled(); await expect(page.getByLabel('Required processing region', { exact: true })).toHaveValue('us');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByLabel('Required processing region', { exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/regional-relay-${name}-mobile.png`, fullPage: true });
      expect(contentCalls(evidence.traffic)).toHaveLength(beforeMismatch);
      evidence.checks.push('canonical relay attempts, summary and region policy survive a fresh browser process without session credentials/authorization, remain inspectable on a narrow viewport, and contain neither provider nor relay secrets');
      await page.evaluate(() => window.regionalRelayAcceptance.close()); await context.close(); context = undefined;
      for (const variant of ['identity', 'region', 'upstream']) {
        corruptMetadata = variant === 'upstream' ? 'upstream' : null;
        const startContent = contentCalls(evidence.traffic).length, startUpstream = fixture.received.length;
        context = await newContext(resolve(temporary, `${name}-${variant}`)); page = await newPage(context);
        await page.goto(`${appOrigin}/?archive=test-relay-${randomUUID()}&case=${variant}`); await page.getByRole('button', { name: 'Providers', exact: true }).click();
        const denied = regionalCard(page); await denied.getByLabel('Relay authorization token', { exact: true }).fill(fixture.token); await denied.getByRole('button', { name: 'Authorize relay', exact: true }).click();
        await expect.poll(async () => (await page.evaluate(() => window.regionalRelayAcceptance.capabilities())).providerTransports.find(value => value.regionalProcessing)?.capability.available).toBe(false);
        await denied.getByLabel('API key', { exact: true }).fill('synthetic-secret'); await denied.getByRole('button', { name: 'Connect credential', exact: true }).click();
        await expect(denied.getByText('Credential connected · Connection not checked', { exact: true })).toBeVisible(); await expect(eligibility(denied)).toBeDisabled();
        expect(contentCalls(evidence.traffic)).toHaveLength(startContent); expect(fixture.received).toHaveLength(startUpstream);
        evidence.negativeCases.push({ variant, additionalContentRequests: 0, additionalUpstreamRequests: 0, method: variant === 'upstream' ? 'negative-only altered metadata response' : 'mismatched trusted operator configuration' });
        await page.evaluate(() => window.regionalRelayAcceptance.close()); await context.close(); context = undefined;
      }
      corruptMetadata = null; expect(pageErrors).toEqual([]);
      evidence.checks.push('wrong pinned relay configuration identity, relay region and upstream origin each refuse eligibility/publication after authenticated metadata exchange, with zero content HTTP or upstream requests');
      evidence.declaration = declaration; evidence.upstreamRequests = fixture.traffic();
      evidence.relayLogs = fixture.logs; evidence.dnsResolutions = fixture.resolutions(); evidence.generationIds = savedAttempts.map(value => value.id); evidence.summaryProposalId = proposal.id;
      expect(JSON.stringify(evidence)).not.toContain(fixture.token); expect(JSON.stringify(evidence)).not.toContain('synthetic-secret'); evidence.status = 'passed'; console.log(`${name}: ${evidence.checks.length} regional relay application checks passed`);
    } catch (error) {
      evidence.status = 'failed';
      evidence.failureRelayLogs = fixture.logs;
      const page = context?.pages().at(-1);
      if (page) { evidence.failureCapabilities = await page.evaluate(() => window.regionalRelayAcceptance.capabilities()).catch(() => null); await page.screenshot({ path: `test-results/regional-relay-${name}-failure.png`, fullPage: true }).catch(() => {}); }
      throw error;
    } finally { if (metadataGate) { const gate = metadataGate; metadataGate = null; for (const release of gate.releases) release(); } await context?.close(); await fixture.close(); }
    await save();
  }
  proof.status = 'passed';
} catch (error) { proof.status = 'failed'; proof.error = String(error?.stack ?? error); process.exitCode = 1; }
finally { proof.finishedAt = new Date().toISOString(); await save(); await previewServer?.httpServer.close(); await rm(temporary, { recursive: true, force: true }); console.log(JSON.stringify({ status: proof.status, hosts: proof.hosts.map(host => ({ name: host.name, status: host.status, checks: host.checks.length })), error: proof.error ?? null }, null, 2)); }
