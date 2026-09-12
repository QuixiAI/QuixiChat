import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const seeds = [
  { title: 'Feline care', text: 'Kittens purr when they are warm, fed and content beside their mother.' },
  { title: 'Storage design', text: 'The OPFS decision was recorded after the migration check passed on every host.' },
  { title: 'Weeknight cooking', text: 'Simmer the tomato sauce for twenty minutes, then fold in the basil.' },
];
const status = (page) => page.evaluate(() => window.appAcceptance.semanticStatus());
const lexicalReady = (page) => expect.poll(async () => (await page.evaluate(() => window.appAcceptance.status())).pendingSources, { timeout: 60_000 }).toBe(0);
async function search(page, mode, text) {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByLabel('Search mode', { exact: true }).selectOption(mode);
  await page.getByLabel('Search your history', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
}
const results = (page) => page.getByRole('region', { name: 'Search results' });
const panel = (page) => page.getByRole('region', { name: 'Semantic search', exact: true });
async function openPanel(page) {
  await page.getByRole('button', { name: 'Semantic search', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function open(engine, profile, url) {
  const context = await engine.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  // Console errors are evidence; browser warnings (e.g. Chromium's "No available
  // adapters." from the onboarding WebGPU probe) are not failures.
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.type()}: ${message.text()}`); });
  page.on('crash', () => errors.push('page crashed'));
  page.on('close', () => errors.push('page closed'));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Pick up where you left off.' })).toBeVisible();
  return { context, page, errors };
}
/** Product §44/§46/§72–§74 through the shared application with the real
 * pinned model, in a fresh archive: enrolment, backend selection, Semantic
 * and Best ranking with explanations, pause/resume, restart resume from the
 * cached model, explicit deletion and lexical usability while the model is
 * unavailable. */
export async function exerciseSemanticSearch({ engine, profile, name, origin }) {
  const evidence = { checks: [] };
  const archive = `test-app-semantic-${randomUUID()}`;
  const url = `${origin}/?archive=${archive}`;
  let { context, page, errors } = await open(engine, profile, url);
  try {
    await page.evaluate((entries) => window.appAcceptance.seedTexts(entries), seeds);
    await lexicalReady(page);
    await openPanel(page);
    await expect(panel(page).getByRole('button', { name: 'Enable local semantic search', exact: true })).toBeVisible();
    await expect(panel(page)).toContainText('All inference stays on this device');
    const before = await status(page);
    expect(before.state).toBe('disabled');
    // Lexical Best before enrolment says why it is lexical only.
    await search(page, 'best', 'migration');
    await expect(page.getByTestId('search-mode-used')).toContainText('semantic search is unavailable');
    await expect(results(page).getByText('Exact text match', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Close results', exact: true }).click();
    evidence.checks.push('before enrolment Best is explicitly lexical-only with the storage reason and exact hits still navigate');
    // Enrol: the runtime downloads and verifies the pinned model, picks a backend.
    const started = Date.now();
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Enable local semantic search', exact: true }).click();
    await expect(page.getByTestId('semantic-backend')).toHaveText(/WASM SIMD · CPU|WebGPU · FP(16|32)/, { timeout: 300_000 });
    evidence.backend = await page.getByTestId('semantic-backend').textContent();
    evidence.runtimeNote = await panel(page).getByRole('status').textContent();
    evidence.enableMs = Date.now() - started;
    await expect(page.getByTestId('semantic-indexed')).toHaveText(/^3 \/ 3 chunks$/, { timeout: 300_000 });
    await expect(page.getByTestId('semantic-state')).toHaveText('Up to date');
    evidence.indexMs = Date.now() - started;
    const enrolled = await status(page);
    expect(enrolled.state).toBe('enrolled');
    expect(enrolled.model.modelName).toBe('snowflake-arctic-embed-xs');
    expect(enrolled.vectors).toBe(3);
    expect(enrolled.vectorBytes).toBe(3 * 384 * 4);
    // ADR 0036: every published vector is projected to int8 at once; small
    // indexes keep exact retrieval and say so.
    expect(enrolled.projection.projected).toBe(3);
    expect(enrolled.projection.complete).toBe(true);
    expect(enrolled.projection.coarseRetrieval).toBe(false);
    await expect(page.getByTestId("semantic-projection")).toHaveText(/3 \/ 3 sign-bit \(0\.0 MB\) · exact retrieval below 100,000 vectors/);
    evidence.model = enrolled.model;
    evidence.checks.push(`enrolment verifies the pinned model, selects ${evidence.backend} and indexes every visible chunk with progress, backend, speed and size shown`);
    // Semantic: a paraphrase with no shared words finds the feline thread first.
    await search(page, 'semantic', 'why does my cat make a rumbling noise');
    await expect(page.getByTestId('search-mode-used')).toHaveText(/^Semantic matches/);
    const semanticHits = results(page).locator('article');
    await expect(semanticHits.first()).toContainText('Feline care');
    await expect(semanticHits.first()).toContainText('Semantic match');
    expect(await semanticHits.count()).toBe(3);
    evidence.checks.push('Semantic mode embeds the query locally and ranks a paraphrase without shared terms first, explained as a semantic match');
    // Best: RRF keeps the exact hit first and explains dual origin; semantic-only hits follow.
    await search(page, 'best', 'migration check');
    await expect(page.getByTestId('search-mode-used')).toHaveText(/^Text and semantic matches/);
    const bestHits = results(page).locator('article');
    await expect(bestHits.first()).toContainText('Storage design');
    await expect(bestHits.first()).toContainText('Exact + semantic match');
    await expect(bestHits.nth(1)).toContainText('Semantic match');
    evidence.checks.push('Best fuses lexical and semantic rankings by reciprocal rank: the dual-origin hit leads and every result explains its origin');
    // Exact never embeds and never reports semantic origin.
    await search(page, 'exact', 'kittens');
    await expect(page.getByTestId('search-mode-used')).toHaveText(/^Text matches ·/);
    await expect(results(page).locator('article')).toHaveCount(1);
    await expect(results(page).getByText('Exact text match', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close results', exact: true }).click();
    evidence.checks.push('Exact mode stays purely lexical');
    // Plan 23 inference diagnostics (product §100/§101): the Storage health
    // self-test re-verifies the model and runs frozen goldens on every backend
    // present here, while the enrolment's route is still live.
    await page.getByRole('button', { name: 'Storage health', exact: true }).click();
    const diagnostics = page.getByRole('region', { name: 'Diagnostics', exact: true });
    await diagnostics.getByRole('button', { name: 'Run inference self-test', exact: true }).click();
    await expect(diagnostics.getByTestId('inference-report-meta')).toBeVisible({ timeout: 120_000 });
    const inference = Object.fromEntries(await diagnostics.locator('[data-testid^="inference-"][data-outcome]').evaluateAll(nodes => nodes.map(node => [node.dataset.testid.slice('inference-'.length), node.dataset.outcome])));
    const selfTest = await page.evaluate(() => window.appAcceptance.embeddingSelfTest());
    evidence.selfTest = { outcomes: inference, route: selfTest.route, kind: selfTest.kind, elapsedMs: selfTest.elapsedMs, checks: selfTest.checks.map(check => ({ id: check.id, outcome: check.outcome, measured: check.measured })) };
    expect(inference).toMatchObject({ model_hash: 'ok', tokenizer: 'ok', scalar_golden: 'ok', wasm_simd_backend: 'ok' });
    // On a GPU route the live route must reproduce the goldens; on a CPU route the check names why WebGPU is not serving (no adapter, or an adapter refused).
    if (evidence.backend.startsWith('WebGPU')) expect(inference.webgpu_backend).toBe('ok'); else expect(['unsupported', 'attention']).toContain(inference.webgpu_backend);
    expect(selfTest.checks.find(check => check.id === 'model_hash').measured.sha256).toBe(enrolled.model.sourceHash);
    expect(selfTest.cases).toHaveLength(3);
    evidence.checks.push(`the Storage health inference self-test re-hashes the model (${selfTest.checks.find(check => check.id === 'model_hash').measured.source}), reproduces the frozen token ids and reference vectors on the scalar and SIMD backends, and reports the WebGPU backend as ${inference.webgpu_backend} on the ${evidence.backend} route`);
    // Pause refuses new work; new content waits; resume indexes only it.
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByTestId('semantic-state')).toHaveText('Paused');
    // Device loss (plan 21): on the WebGPU route the owned device is destroyed
    // through the diagnostics hook; the next chunk must be embedded by the CPU
    // fallback and the panel must report the switch. On the CPU route the
    // injection is refused and nothing changes.
    const backendBefore = await page.getByTestId('semantic-backend').textContent();
    evidence.faultInjected = await page.evaluate(() => window.appAcceptance.injectEmbeddingFault('gpu-device-loss'));
    expect(evidence.faultInjected).toBe(backendBefore.startsWith('WebGPU'));
    await page.evaluate(() => window.appAcceptance.seedTexts([{ title: 'Gardening', text: 'Water the tomato seedlings every morning before the sun is high.' }]));
    await lexicalReady(page);
    await expect(page.getByTestId('semantic-indexed')).toHaveText(/^3 \/ 4 chunks$/, { timeout: 30_000 });
    await page.waitForTimeout(1_500);
    expect((await status(page)).indexedChunks).toBe(3);
    await search(page, 'semantic', 'growing vegetables');
    await expect(results(page).locator('article').first()).toContainText('Weeknight cooking');
    await page.getByRole('button', { name: 'Close results', exact: true }).click();
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByTestId('semantic-indexed')).toHaveText(/^4 \/ 4 chunks$/, { timeout: 120_000 });
    expect((await status(page)).vectors).toBe(4);
    evidence.checks.push('Pause keeps stored vectors searchable and refuses new claims; Resume indexes only the chunk added meanwhile');
    evidence.backendAfterFault = await page.getByTestId('semantic-backend').textContent();
    if (evidence.faultInjected) {
      expect(evidence.backendAfterFault).toBe('WASM SIMD · CPU');
      evidence.checks.push(`after an injected GPU device loss the query and the resumed chunk are embedded by the CPU fallback and the panel reports ${evidence.backendAfterFault} instead of ${backendBefore}`);
    } else {
      expect(evidence.backendAfterFault).toBe(backendBefore);
      evidence.checks.push(`on the CPU route a GPU device-loss injection is refused and the backend stays ${backendBefore}`);
    }
    // Restart: the enrolment resumes from storage and the model from its OPFS copy.
    expect(errors).toEqual([]);
    await context.close();
    const restarted = await open(engine, profile, url);
    context = restarted.context; page = restarted.page; errors = restarted.errors;
    const reopened = Date.now();
    await openPanel(page);
    await expect(page.getByTestId('semantic-backend')).toHaveText(/WASM SIMD · CPU|WebGPU · FP(16|32)/, { timeout: 300_000 });
    evidence.restartMs = Date.now() - reopened;
    await expect(panel(page).getByRole('status')).toContainText('from the cached model');
    await expect(page.getByTestId('semantic-indexed')).toHaveText(/^4 \/ 4 chunks$/);
    expect((await status(page)).generation).toBe(enrolled.generation);
    await search(page, 'semantic', 'growing vegetables');
    await expect(results(page).locator('article').first()).toContainText('Gardening');
    await page.getByRole('button', { name: 'Close results', exact: true }).click();
    evidence.checks.push('after a browser restart the enrolment, generation and vectors persist, the verified model loads from its OPFS copy and semantic queries work without re-indexing');
    // Disable keeps the index and releases the runtime; Delete then drops the
    // vectors while canonical records stay and exact search keeps working.
    const recordsBefore = (await page.evaluate(() => window.appAcceptance.records('messages'))).items.length;
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Disable', exact: true }).click();
    await expect(page.getByTestId('semantic-state')).toHaveText('Disabled (index kept)', { timeout: 30_000 });
    expect((await status(page)).vectors).toBe(4);
    expect(errors).toEqual([]);
    evidence.checks.push('Disable stops indexing and unloads the runtime while the stored index and enrolment survive');
    await panel(page).getByRole('button', { name: 'Delete semantic index', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'Enable local semantic search', exact: true })).toBeVisible({ timeout: 30_000 });
    const deleted = await status(page);
    expect(deleted).toMatchObject({ state: 'disabled', vectors: 0, model: null });
    expect((await page.evaluate(() => window.appAcceptance.records('messages'))).items.length).toBe(recordsBefore);
    await search(page, 'exact', 'tomato');
    await expect(results(page).locator('article')).toHaveCount(2);
    await page.getByRole('button', { name: 'Close results', exact: true }).click();
    await search(page, 'semantic', 'tomato');
    await expect(page.getByText(/Semantic search is unavailable: Semantic search is not enabled/)).toBeVisible();
    evidence.checks.push('Delete semantic index removes every vector and the enrolment, keeps canonical messages and lexical search, and Semantic mode states that it is not enabled');
    expect(errors).toEqual([]);
    await page.evaluate(() => window.appAcceptance.close());
    await context.close();
    // Missing model with the OPFS copy disabled (a verified cached copy would
    // legitimately substitute): enabling fails with the asset reason; lexical
    // search is unaffected.
    const missing = await open(engine, `${profile}-missing`, `${origin}/?archive=test-app-semantic-missing-${randomUUID()}&embedding=missing`);
    context = missing.context; page = missing.page; errors = missing.errors;
    await page.evaluate((entries) => window.appAcceptance.seedTexts(entries), seeds);
    await lexicalReady(page);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Enable local semantic search', exact: true }).click();
    // The preview answers unknown paths with the SPA page (HTTP 200); the
    // worker refuses it by digest. A plain 404 is reported the same way.
    await expect(panel(page).getByRole('alert')).toContainText(/does not match its pinned SHA-256|unavailable \(HTTP 404\)/, { timeout: 60_000 });
    await expect(page.getByTestId('semantic-state')).toHaveText('Runtime failed');
    await search(page, 'best', 'migration');
    await expect(page.getByTestId('search-mode-used')).toHaveText(/^Text and semantic matches|^Text matches/);
    await expect(page.getByText(/Semantic ranking unavailable/)).toBeVisible();
    await expect(results(page).getByText('Exact text match', { exact: true }).first()).toBeVisible();
    evidence.checks.push('an unprovisioned model is reported as an explicit asset failure; Best falls back to text matches with a visible reason and exact hits remain');
    await page.evaluate(() => window.appAcceptance.close());
  } catch (error) {
    console.error(`${name} page errors before diagnostics: ${JSON.stringify(errors)}; closed=${page.isClosed()}; evidence=${JSON.stringify(evidence)}`);
    try {
      await page.screenshot({ path: `test-results/app-semantic-${name}-failure.png`, fullPage: true });
      console.error(`${name} semantic failure DOM:\n${await page.locator('body').innerText()}`);
      console.error(`${name} page errors: ${JSON.stringify(errors)}`);
      console.error(`${name} semantic status: ${JSON.stringify(await status(page).catch(String))}`);
    } catch { /* diagnostics only */ }
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
  evidence.name = name;
  return evidence;
}
