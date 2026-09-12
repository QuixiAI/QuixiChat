import { expect } from '@playwright/test';

/** The AppRoot fixture injects reviewed native capability declarations into a
 * real settings controller. All dispatch uses the production browser HostClient
 * on loopback; these checks do not establish native execution or geography. */
export async function exerciseRegionalRouting({ page, records, send, requests, countRequests, failNext, seededPng, name }) {
  const beforeConnections = requests.length;
  for (const label of ['OpenAI · US', 'OpenAI · Europe (EEA + Switzerland)']) {
    await page.getByRole('button', { name: 'Providers', exact: true }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
    await card.getByLabel('API key', { exact: true }).fill('synthetic-secret');
    await card.getByRole('button', { name: 'Connect credential', exact: true }).click();
    await expect(card.getByText('Credential connected · Connection not checked', { exact: true })).toBeVisible();
    await card.getByLabel('I confirmed this credential is eligible for regional processing', { exact: true }).check();
    await card.getByLabel('I confirmed regional image-processing eligibility', { exact: true }).check();
    await expect(card.getByText('Eligibility: user-confirmed for text and images.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Library', exact: true }).click();
  }
  expect(requests.length).toBe(beforeConnections);
  const seed = await page.evaluate(png => window.appAcceptance.seedImageThread(png, 'Regional notebook'), seededPng);
  await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
  await page.getByRole('button', { name: 'Regional notebook', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Regional notebook', exact: true })).toBeVisible();
  const state = async () => (await records(page, 'threadStates')).items.find(value => value.threadId === seed.threadId);
  const attempts = async () => (await records(page, 'generations')).items.filter(value => value.threadId === seed.threadId).sort((left, right) => left.createdAt - right.createdAt);
  const messages = async () => (await records(page, 'messages')).items.filter(value => value.threadId === seed.threadId);
  const eventRecords = async () => (await records(page, 'events')).items.filter(value => value.threadId === seed.threadId);
  const region = page.getByLabel('Required processing region', { exact: true });
  const route = page.locator('.route-plan');
  const add = async id => {
    await page.getByLabel('Fallback candidate', { exact: true }).selectOption(`${id}:gpt-4.1-mini-2025-04-14`);
    await page.getByRole('button', { name: 'Add candidate', exact: true }).click();
    await expect.poll(async () => (await state()).routingProfile.candidates.some(value => value.provider === id)).toBe(true);
  };
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await page.getByLabel('Maximum output tokens', { exact: true }).fill('256');
  await region.selectOption('us');
  await expect.poll(async () => (await state()).routingProfile.requirements.processingRegion).toBe('us');
  expect((await state()).routingProfile.version).toBe(5);
  await page.getByRole('checkbox', { name: 'Allow the route to change the privacy class', exact: true }).click();
  await expect.poll(async () => (await state()).routingProfile.allowPrivacyChange).toBe(true);
  await expect(page.getByRole('checkbox', { name: 'Allow the route to change the privacy class', exact: true })).toBeChecked();
  await add('openai-eu'); await add('openai');
  await page.getByLabel('Message', { exact: true }).fill('Keep this synthetic conversation in the required processing region.');
  await expect(route).toContainText('Processing region is unknown');
  await expect(route).toContainText('Europe (EEA + Switzerland) does not match required United States');
  const beforeDenied = requests.length, beforeDeniedCount = countRequests.length, beforeDeniedMessages = (await messages()).length;
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.getByLabel('Message', { exact: true }).press('Control+Enter');
  await page.getByRole('button', { name: 'Count prompt tokens', exact: true }).click();
  await expect(page.locator('.prompt-count')).toContainText('Processing region is unknown');
  expect(requests.length).toBe(beforeDenied); expect(countRequests.length).toBe(beforeDeniedCount); expect((await messages()).length).toBe(beforeDeniedMessages);
  await add('openai-us');
  await expect(route).toContainText('openai-us-gpt41-mini-2026-09-10');
  // Counting still targets the selected Anthropic connection, even when the
  // initial generation route skips it in favor of the eligible US candidate.
  await page.getByRole('button', { name: 'Count prompt tokens', exact: true }).click();
  await expect(page.locator('.prompt-count')).toContainText('Processing region is unknown');
  await send(page, 'Keep this synthetic conversation in the required processing region.');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect.poll(async () => (await attempts()).at(-1)?.status).toBe('complete');
  expect(requests.length).toBe(beforeDenied + 1); expect(countRequests.length).toBe(beforeDeniedCount);
  const initial = (await attempts()).at(-1); expect(initial.provider).toBe('openai'); expect(initial.model).toBe('gpt-4.1-mini-2025-04-14');
  const lastDispatch = (await page.evaluate(() => window.appAcceptance.providerDispatches())).at(-1);
  expect(lastDispatch).toEqual({ binding: { providerId: 'openai', accountId: 'primary', destinationId: 'quixi-openai-us-api-v1', transportId: 'quixi-openai-us-native-v1' }, path: '/v1/chat/completions', method: 'POST' });
  expect(requests.at(-1).body).toMatchObject({ model: 'gpt-4.1-mini-2025-04-14', max_completion_tokens: 256 });
  const initialEvent = (await eventRecords()).find(value => value.type === 'AutomaticFallback');
  expect(initialEvent.details).toMatchObject({ from: { provider: 'anthropic' }, to: { provider: 'openai-us' }, primaryStatus: 'not_attempted' });
  expect(initialEvent.details.reason).toContain('openai-us-gpt41-mini-2026-09-10');

  const summary = page.getByRole('region', { name: 'Conversation summary', exact: true });
  await summary.getByRole('button', { name: 'Review conversation summaries', exact: true }).click();
  await summary.getByRole('button', { name: 'Prepare summary request', exact: true }).click();
  const review = summary.getByRole('region', { name: 'Review summary request', exact: true });
  await review.getByRole('checkbox', { name: 'I reviewed this summary request and its destination', exact: true }).check();
  await expect(review).toContainText('Processing region is unknown');
  await expect(review.getByRole('button', { name: 'Count summary input', exact: true })).toBeDisabled();
  await expect(review.getByRole('button', { name: 'Generate summary proposal', exact: true })).toBeDisabled();
  expect(requests.length).toBe(beforeDenied + 1); expect(countRequests.length).toBe(beforeDeniedCount);
  await summary.getByRole('button', { name: 'Close summary review', exact: true }).click();
  await page.getByLabel('Provider', { exact: true }).selectOption('openai-us');
  await page.getByLabel('Maximum output tokens', { exact: true }).fill('256');
  await summary.getByRole('button', { name: 'Review conversation summaries', exact: true }).click();
  await summary.getByRole('button', { name: 'Prepare summary request', exact: true }).click();
  await review.getByRole('checkbox', { name: 'I reviewed this summary request and its destination', exact: true }).check();
  await expect(review).toContainText('openai-us-gpt41-mini-2026-09-10');
  await expect(review.getByRole('button', { name: 'Generate summary proposal', exact: true })).toBeEnabled();
  await review.screenshot({ path: `test-results/regions-${name}-summary.png` });
  await review.getByRole('button', { name: 'Generate summary proposal', exact: true }).click();
  await expect(summary.getByLabel('Reviewed summary', { exact: true })).toBeEnabled({ timeout: 15000 });
  expect(requests.length).toBe(beforeDenied + 2); expect(requests.at(-1).body.max_completion_tokens).toBe(256);
  const summaryProposal = (await records(page, 'summaryProposals')).items.filter(value => value.threadId === seed.threadId).at(-1);
  const summaryAttempt = (await attempts()).find(value => value.id === summaryProposal.generationId);
  expect(summaryAttempt.provider).toBe('openai');
  await summary.getByRole('button', { name: 'Close summary review', exact: true }).click();
  if (await page.locator('.switch-report').count()) await page.getByRole('checkbox', { name: /I reviewed this switch/ }).check();
  const beforeRegenerate = requests.length;
  await page.getByRole('button', { name: /^Generate another response — / }).first().click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBe(beforeRegenerate + 1);
  await expect.poll(async () => (await attempts()).at(-1)?.status).toBe('complete');
  expect((await attempts()).at(-1).provider).toBe('openai'); expect(countRequests.length).toBe(beforeDeniedCount);
  const beforeFailure = requests.length, beforeFailureAttempts = (await attempts()).length;
  failNext({ status: 503, body: { error: { type: 'overloaded_error', message: 'Synthetic regional primary failure' } } });
  await send(page, 'Regional fallback must reject unknown and different-region destinations.');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Fallback was not used');
  await expect(page.getByRole('alert')).toContainText('Processing region');
  expect(requests.length).toBe(beforeFailure + 1); expect(countRequests.length).toBe(beforeDeniedCount);
  expect((await attempts()).length).toBe(beforeFailureAttempts + 1); expect((await attempts()).at(-1).provider).toBe('openai');
  const regionAttempts = await attempts();
  for (const attempt of regionAttempts) expect(JSON.stringify(attempt.compatibility)).toContain('openai-us-gpt41-mini-2026-09-10');

  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('button', { name: 'New routing alias', exact: true }).click();
  const editor = page.getByRole('form', { name: 'Routing alias editor' });
  await editor.getByLabel('Alias name', { exact: true }).fill('Regional');
  await editor.getByLabel('Alias primary', { exact: true }).selectOption(JSON.stringify(['openai-us', 'gpt-4.1-mini-2025-04-14']));
  await editor.getByLabel('Alias fallback candidate', { exact: true }).selectOption(JSON.stringify(['openai-eu', 'gpt-4.1-mini-2025-04-14']));
  await editor.getByRole('button', { name: 'Add alias fallback', exact: true }).click();
  await editor.getByLabel('Alias required processing region', { exact: true }).selectOption('us');
  await editor.getByRole('button', { name: 'Save routing alias', exact: true }).click(); await expect(editor).toHaveCount(0);
  const alias = (await page.evaluate(() => window.appAcceptance.aliases())).aliases.find(value => value.name === 'Regional');
  expect(alias.requirements.processingRegion).toBe('us');
  await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: 'Regional notebook', exact: true }).click();
  await page.getByLabel('Routing alias', { exact: true }).selectOption(alias.id);
  const aliasReview = page.getByRole('region', { name: 'Apply routing alias', exact: true });
  await expect(aliasReview).toContainText('remote content processing in US for every attempt, fallback, and token count');
  await aliasReview.getByRole('checkbox', { name: 'I reviewed this alias profile', exact: true }).check();
  await aliasReview.getByRole('button', { name: 'Apply alias to conversation', exact: true }).click();
  await expect.poll(async () => (await state()).routingProfile.alias).toBe('Regional');
  const snapshot = (await state()).routingProfile; expect(snapshot.version).toBe(5); expect(snapshot.requirements.processingRegion).toBe('us');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Regional', exact: true }).click();
  await editor.getByLabel('Alias required processing region', { exact: true }).selectOption('eu');
  await editor.getByRole('button', { name: 'Save routing alias', exact: true }).click(); await expect(editor).toHaveCount(0);
  expect((await page.evaluate(() => window.appAcceptance.aliases())).aliases.find(value => value.id === alias.id).requirements.processingRegion).toBe('eu');
  await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: 'Regional notebook', exact: true }).click();
  expect((await state()).routingProfile).toEqual(snapshot); await expect(region).toHaveValue('us');
  const beforeBranch = requests.length, oldLeaf = (await state()).activeLeafMessageId;
  await page.getByRole('button', { name: 'Review fresh branch', exact: true }).click();
  const fresh = page.getByRole('region', { name: 'Review fresh branch', exact: true });
  await fresh.getByRole('checkbox').check(); await fresh.getByRole('button', { name: 'Start fresh branch', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Fresh context branch', exact: true })).toContainText('An empty branch is selected');
  expect((await state()).routingProfile).toEqual(snapshot); expect((await state()).activeLeafMessageId).toBeNull();
  expect(requests.length).toBe(beforeBranch); expect(countRequests.length).toBe(beforeDeniedCount);
  await region.scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/regions-${name}-route.png`, fullPage: true });
  return { threadId: seed.threadId, profile: snapshot, aliasId: alias.id, aliasCurrentRegion: 'eu', freshContextId: (await state()).contextSnapshotId, oldLeaf, summaryProposalId: summaryProposal.id, initialEventId: initialEvent.id, generationIds: regionAttempts.map(value => value.id), dispatchBinding: lastDispatch.binding, scope: 'Injected native capability fixture plus actual loopback production WebHost dispatch; no physical geography assertion.' };
}

export async function verifyRegionalRestart({ page, records, requests, countRequests, evidence, name }) {
  const beforeHttp = requests.length, beforeCount = countRequests.length;
  await page.getByRole('button', { name: 'Regional notebook', exact: true }).click();
  const state = (await records(page, 'threadStates')).items.find(value => value.threadId === evidence.threadId);
  expect(state.routingProfile).toEqual(evidence.profile); expect(state.contextSnapshotId).toBe(evidence.freshContextId); expect(state.activeLeafMessageId).toBeNull();
  await expect(page.getByLabel('Required processing region', { exact: true })).toHaveValue('us');
  await expect(page.getByRole('region', { name: 'Fresh context branch', exact: true })).toContainText('An empty branch is selected');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  const registry = await page.evaluate(() => window.appAcceptance.aliases());
  expect(registry.aliases.find(value => value.id === evidence.aliasId).requirements.processingRegion).toBe('eu');
  const saved = (await records(page, 'generations')).items.filter(value => evidence.generationIds.includes(value.id));
  expect(saved).toHaveLength(evidence.generationIds.length);
  for (const attempt of saved) expect(JSON.stringify(attempt.compatibility)).toContain('openai-us-gpt41-mini-2026-09-10');
  expect((await records(page, 'summaryProposals')).items.some(value => value.id === evidence.summaryProposalId)).toBe(true);
  expect(requests.length).toBe(beforeHttp); expect(countRequests.length).toBe(beforeCount);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Required processing region', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/regions-${name}-mobile.png`, fullPage: true });
}
