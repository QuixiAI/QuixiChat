import { expect } from '@playwright/test';

const title = 'Sources notebook';
const sourceNote = '[Source: Synthetic comet source — https://example.invalid/comet-source]';
const partsOf = (page, messageId) => page.evaluate(id => window.appAcceptance.parts(id), messageId).then(result => result.items);
async function settings(page, label = 'Provider') {
  if (!(await page.getByLabel(label, { exact: true }).isVisible())) await page.getByText('Conversation settings', { exact: true }).click();
}
async function selectModel(page, id) {
  const select = page.getByLabel('Model', { exact: true });
  if (await select.count()) await select.selectOption(id);
  else await page.getByRole('group', { name: 'Model choices', exact: true }).locator(`input[type="radio"][value="${id}"]`).check();
}
async function choose(page, provider, model) {
  await settings(page);
  await page.getByLabel('Provider', { exact: true }).selectOption(provider);
  await selectModel(page, model);
}
async function completed(page, records, before) {
  await expect.poll(async () => (await records(page, 'generations')).items.length).toBe(before + 1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const generation = (await records(page, 'generations')).items.sort((a, b) => a.createdAt - b.createdAt).at(-1);
  await expect.poll(async () => (await records(page, 'generations')).items.find(value => value.id === generation.id).status).toBe('complete');
  return generation;
}
/** Every assistant text block of a request body, flattened. */
const assistantTexts = body => body.messages.filter(message => message.role === 'assistant')
  .flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text) : typeof message.content === 'string' ? [message.content] : []);
const providerSpecific = body => JSON.stringify(body).match(/citations|annotations|future_file_output|reasoning_content|provider_refusal/g) ?? [];
/** Citations, unknown output blocks and provider-specific delta fields are
 * retained as parts and transformed or omitted, never refused, on the next
 * request to either provider; the switch report names each transformation. */
export async function exerciseOutputParts({ page, records, send, requests, countRequests }) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await settings(page, 'Title');
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await choose(page, 'anthropic', 'claude-haiku-4-5-20251001');
  await page.getByLabel('Thinking budget', { exact: true }).fill('');
  let generations = (await records(page, 'generations')).items.length;
  await send(page, 'Please cite this claim about the comet');
  const cited = await completed(page, records, generations);
  const parts = await partsOf(page, cited.outputMessageId);
  const citation = parts.find(part => part.kind === 'Citation');
  expect(citation.data).toEqual({ url: 'https://example.invalid/comet-source', label: 'Synthetic comet source', sourcePartId: null });
  const unknown = parts.filter(part => part.kind === 'ProviderArtifact' && part.data.providerKind === 'future_file_output');
  expect(unknown).toHaveLength(1);
  expect(unknown[0].data.locator).toMatch(/^generation-stream\/record\/\d+$/);
  const response = page.locator('.message.assistant').last();
  await expect(response).toContainText('Synthetic comet source');
  await expect(response.getByText('Original provider content', { exact: true }).first()).toBeVisible();
  // The next Anthropic request carries the answer with a source note and no
  // provider-specific block; count and regeneration agree.
  const countsBefore = countRequests.length;
  await page.getByLabel('Message', { exact: true }).fill('Count with the source note');
  await page.getByRole('button', { name: 'Count prompt tokens', exact: true }).click();
  await expect(page.locator('.prompt-count')).toContainText('tokens counted by Anthropic');
  expect(countRequests.length).toBe(countsBefore + 1);
  expect(assistantTexts(countRequests.at(-1).body).join('')).toContain(sourceNote);
  expect(providerSpecific(countRequests.at(-1).body)).toEqual([]);
  generations = (await records(page, 'generations')).items.length;
  await send(page, 'Continue with the sources');
  await completed(page, records, generations);
  const followUp = requests.at(-1).body;
  expect(requests.at(-1).anthropic).toBe(true);
  const joined = assistantTexts(followUp).join('');
  expect(joined).toContain('segment 7');
  expect(joined.indexOf(sourceNote)).toBeGreaterThan(joined.indexOf('segment 7'));
  expect(providerSpecific(followUp)).toEqual([]);
  generations = (await records(page, 'generations')).items.length;
  await page.getByRole('button', { name: /^Generate another response — / }).last().click();
  await completed(page, records, generations);
  expect(assistantTexts(requests.at(-1).body).join('')).toContain(sourceNote);
  expect(providerSpecific(requests.at(-1).body)).toEqual([]);
  // Switching to OpenAI names the transformations and carries no
  // provider-specific record either; its own citation is retained the same way.
  await choose(page, 'openai', 'gpt-4.1-mini-2025-04-14');
  const switchReport = page.getByRole('region', { name: 'Compatibility report' });
  await expect(switchReport).toContainText('1 citation sent as a plain source note because providers accept citations only with their cited documents');
  await expect(switchReport).toContainText('1 provider-specific output record omitted because no provider accepts it as input; the original is retained');
  await expect(switchReport).toContainText('Blocked: 0');
  generations = (await records(page, 'generations')).items.length;
  await send(page, 'Now cite this on the other provider');
  const openaiCited = await completed(page, records, generations);
  expect(requests.at(-1).anthropic).toBe(false);
  expect(assistantTexts(requests.at(-1).body).join('')).toContain(sourceNote);
  expect(providerSpecific(requests.at(-1).body)).toEqual([]);
  const openaiParts = await partsOf(page, openaiCited.outputMessageId);
  expect(openaiParts.filter(part => part.kind === 'Citation')).toHaveLength(1);
  expect(openaiParts.filter(part => part.kind === 'ProviderArtifact' && part.data.providerKind === 'openai.delta.reasoning_content')).toHaveLength(1);
  await choose(page, 'anthropic', 'claude-haiku-4-5-20251001');
  await expect(switchReport).toContainText('2 citations sent as a plain source note');
  await expect(switchReport).toContainText('2 provider-specific output records omitted');
  generations = (await records(page, 'generations')).items.length;
  await send(page, 'And back with both sources');
  await completed(page, records, generations);
  expect(assistantTexts(requests.at(-1).body).filter(text => text.includes(sourceNote))).toHaveLength(2);
  expect(providerSpecific(requests.at(-1).body)).toEqual([]);
  expect(await partsOf(page, cited.outputMessageId)).toEqual(parts);
  return { threadId: cited.threadId, citedMessageId: cited.outputMessageId, openaiMessageId: openaiCited.outputMessageId };
}
