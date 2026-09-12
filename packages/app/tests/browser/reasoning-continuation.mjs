import { expect } from '@playwright/test';

const title = 'Reasoning notebook';
const RECEIPT = 'quixi.provider.anthropic-thinking-block';
/** The blocks the fixture streams for a "think first" prompt, exactly as the
 * provider contract requires them back: complete, signed and unmodified. */
export const expectedBlocks = [
  { type: 'thinking', thinking: 'fixture reasoning about the comet 🧪\n', signature: 'fixture-signature-comet+/=' },
  { type: 'redacted_thinking', data: 'fixture-redacted-comet+/=' },
];
const carried = body => body.messages
  .filter(message => message.role === 'assistant' && Array.isArray(message.content))
  .flatMap(message => message.content.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking'));
/** One message's ordered parts through the message-scoped reader; the
 * collection reader is bounded to eight pages of the whole archive. */
const partsOf = (page, messageId) => page.evaluate(id => window.appAcceptance.parts(id), messageId).then(result => result.items);
const assistantWithReasoning = body => body.messages.find(message => message.role === 'assistant' && Array.isArray(message.content) && message.content[0]?.type === 'thinking');
async function settings(page, label = 'Provider') {
  if (!(await page.getByLabel(label, { exact: true }).isVisible())) await page.getByText('Conversation settings', { exact: true }).click();
}
async function selectModel(page, id) {
  const select = page.getByLabel('Model', { exact: true });
  if (await select.count()) await select.selectOption(id);
  else await page.getByRole('group', { name: 'Model choices', exact: true }).locator(`input[type="radio"][value="${id}"]`).check();
}
async function anthropic(page) {
  await settings(page);
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await selectModel(page, 'claude-haiku-4-5-20251001');
}
async function completed(page, records, before) {
  await expect.poll(async () => (await records(page, 'generations')).items.length).toBe(before + 1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const generation = (await records(page, 'generations')).items.sort((a, b) => a.createdAt - b.createdAt).at(-1);
  await expect.poll(async () => (await records(page, 'generations')).items.find(value => value.id === generation.id).status).toBe('complete');
  return generation;
}
/** Manual thinking for the reviewed Haiku 4.5 profile and continuation of the
 * response's signed/redacted blocks from verified receipts through count,
 * send, regeneration and a cross-provider switch, all in the shared app. */
export async function exerciseReasoningContinuation({ page, records, send, requests, countRequests }) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await settings(page, 'Title');
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await anthropic(page);
  const outputLimit = page.getByLabel('Maximum output tokens', { exact: true });
  const temperature = page.getByLabel('Temperature', { exact: true });
  const topP = page.getByLabel('Top-p', { exact: true });
  const thinkingBudget = page.getByLabel('Thinking budget', { exact: true });
  const help = page.locator('#thinking-budget-help');
  const composer = page.getByLabel('Message', { exact: true });
  const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(thinkingBudget).toBeVisible();
  await expect(thinkingBudget).toHaveAttribute('min', '1024');
  await outputLimit.fill('768'); await temperature.fill(''); await topP.fill('');
  await composer.fill('Draft kept while thinking settings are invalid');
  // Every documented constraint blocks sending without a write or a request.
  const messagesBefore = (await records(page, 'messages')).items.length, requestsBefore = requests.length;
  for (const [apply, problem] of [
    [async () => thinkingBudget.fill('512'), 'Enter a whole number of at least 1,024 tokens.'],
    [async () => thinkingBudget.fill('1024'), 'The budget must be below the output-token limit.'],
    [async () => { await outputLimit.fill('4096'); await temperature.fill('0.3'); }, 'Clear temperature while thinking is enabled.'],
    [async () => { await temperature.fill(''); await topP.fill('0.9'); }, 'Top-p must be blank or between 0.95 and 1 while thinking is enabled.'],
  ]) {
    await apply();
    await expect(thinkingBudget).toHaveAttribute('aria-invalid', 'true');
    await expect(help).toHaveText(problem);
    await expect(sendButton).toBeDisabled();
    await composer.press('Control+Enter');
    expect((await records(page, 'messages')).items).toHaveLength(messagesBefore);
    expect(requests.length).toBe(requestsBefore);
  }
  await topP.fill('0.95');
  await expect(thinkingBudget).toHaveAttribute('aria-invalid', 'false');
  await expect(help).toContainText('Leave blank to keep thinking off');
  await expect(composer).toHaveValue('Draft kept while thinking settings are invalid');
  // A thinking-enabled send carries the reviewed parameter and records the
  // complete blocks as receipts beside their markers.
  let generations = (await records(page, 'generations')).items.length;
  await send(page, 'Please think first about the comet orbit');
  const thinkingGeneration = await completed(page, records, generations);
  const thinkingRequest = requests.at(-1).body;
  expect(requests.at(-1).anthropic).toBe(true);
  expect(thinkingRequest.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  expect(thinkingRequest.max_tokens).toBe(4096);
  expect(thinkingRequest.top_p).toBe(0.95);
  expect('temperature' in thinkingRequest).toBe(false);
  expect(carried(thinkingRequest)).toEqual([]);
  const outputParts = await partsOf(page, thinkingGeneration.outputMessageId);
  expect(outputParts.filter(part => part.kind === 'ReasoningMetadata').map(part => part.data.redacted)).toEqual([false, true]);
  expect(outputParts.filter(part => part.kind === 'ProviderArtifact' && part.data.providerKind === RECEIPT).map(part => part.data.locator)).toEqual(['block/0', 'block/1']);
  const response = page.locator('.message.assistant').last();
  await expect(response).toContainText('Visible stream 🧪');
  await expect(response).toContainText('Reasoning metadata retained.');
  await expect(response).toContainText('Reasoning is redacted.');
  await expect(response.getByText('Response source records', { exact: true })).toBeVisible();
  // Count, send and regeneration carry the verified blocks first and unchanged.
  const countsBefore = countRequests.length;
  await composer.fill('Count with the reasoning carried');
  await page.getByRole('button', { name: 'Count prompt tokens', exact: true }).click();
  await expect(page.locator('.prompt-count')).toContainText('tokens counted by Anthropic for this draft and branch.');
  expect(countRequests.length).toBe(countsBefore + 1);
  const counted = countRequests.at(-1).body;
  expect(counted.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  expect(carried(counted)).toEqual(expectedBlocks);
  expect(assistantWithReasoning(counted).content.slice(0, 3)).toEqual([...expectedBlocks, { type: 'text', text: expect.stringMatching(/^Visible stream 🧪/) }]);
  await thinkingBudget.fill('');
  generations = (await records(page, 'generations')).items.length;
  await send(page, 'Continue with that reasoning');
  await completed(page, records, generations);
  const followUp = requests.at(-1).body;
  expect('thinking' in followUp).toBe(false);
  expect(carried(followUp)).toEqual(expectedBlocks);
  expect(assistantWithReasoning(followUp).content.slice(0, 3)).toEqual([...expectedBlocks, { type: 'text', text: expect.stringMatching(/^Visible stream 🧪/) }]);
  expect(JSON.stringify(followUp)).not.toContain(RECEIPT);
  await thinkingBudget.fill('2048');
  generations = (await records(page, 'generations')).items.length;
  await page.getByRole('button', { name: /^Generate another response — / }).last().click();
  await completed(page, records, generations);
  const regenerated = requests.at(-1).body;
  expect(regenerated.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  expect(carried(regenerated)).toEqual(expectedBlocks);
  // Another provider cannot read these blocks: the switch report says they
  // are omitted, and the request carries none of them.
  await page.getByLabel('Provider', { exact: true }).selectOption('openai');
  await selectModel(page, 'gpt-4.1-mini-2025-04-14');
  await expect(thinkingBudget).toHaveCount(0);
  const switchReport = page.getByRole('region', { name: 'Compatibility report' });
  await expect(switchReport).toContainText('2 thinking blocks from another model omitted because only the producing model can read them');
  await expect(switchReport).toContainText('Blocked: 0');
  await expect(page.getByRole('region', { name: 'Portability', exact: true })).toContainText('some targets omit reasoning blocks they cannot read or verify');
  generations = (await records(page, 'generations')).items.length;
  await send(page, 'Continue on the other provider');
  await completed(page, records, generations);
  expect(requests.at(-1).anthropic).toBe(false);
  expect(carried(requests.at(-1).body)).toEqual([]);
  expect(JSON.stringify(requests.at(-1).body)).not.toContain('fixture-signature-comet');
  expect(JSON.stringify(requests.at(-1).body)).not.toContain('fixture-redacted-comet');
  // Back on the producing model the blocks return, and the history is unchanged.
  await anthropic(page);
  await expect(switchReport).not.toContainText('omitted because only the producing model');
  generations = (await records(page, 'generations')).items.length;
  await send(page, 'And back again');
  await completed(page, records, generations);
  expect(carried(requests.at(-1).body)).toEqual(expectedBlocks);
  // The acceptance reader returns a byte-bounded page, so compare the
  // markers and receipts rather than every raw transport row.
  const semantic = parts => parts.filter(part => part.kind === 'ReasoningMetadata' || (part.kind === 'ProviderArtifact' && part.data.providerKind === RECEIPT));
  const outputPartsAfter = await partsOf(page, thinkingGeneration.outputMessageId);
  expect(semantic(outputPartsAfter)).toEqual(semantic(outputParts));
  expect(semantic(outputParts)).toHaveLength(4);
  const threadId = thinkingGeneration.threadId;
  return { threadId, outputMessageId: thinkingGeneration.outputMessageId, receipts: outputParts.filter(part => part.kind === 'ProviderArtifact' && part.data.providerKind === RECEIPT).map(part => part.data.rawObjectId) };
}
/** After a fresh browser process the receipts still verify and a follow-up
 * on the producing model carries the same blocks. */
export async function verifyReasoningContinuationRestart({ page, records, send, requests, connect }, saved) {
  await connect(page, 'Anthropic');
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await anthropic(page);
  const generations = (await records(page, 'generations')).items.length;
  await send(page, 'Continue after restart');
  await completed(page, records, generations);
  expect(carried(requests.at(-1).body)).toEqual(expectedBlocks);
  const parts = await partsOf(page, saved.outputMessageId);
  expect(parts.filter(part => part.kind === 'ProviderArtifact' && part.data.providerKind === RECEIPT).map(part => part.data.rawObjectId)).toEqual(saved.receipts);
}
