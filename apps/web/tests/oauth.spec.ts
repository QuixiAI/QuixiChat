import { test as base, expect, chromium, webkit, type Page, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const test = base.extend({ context: async ({ browserName }, use) => {
  const directory = await mkdtemp(join(tmpdir(), 'quixi-web-oauth-'));
  const context = await (browserName === 'webkit' ? webkit : chromium).launchPersistentContext(directory, { headless: true, baseURL: 'http://127.0.0.1:4216', ...(browserName === 'chromium' ? { ignoreDefaultArgs: ['--disable-back-forward-cache'] } : {}) });
  try { await use(context); } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
} });
type Stats = { authorizations: { valid: boolean; referrerPresent: boolean; cookiePresent: boolean }[]; tokens: { method: string; codeKnown: boolean; pkceMatches: boolean; clientMatches: boolean; redirectMatches: boolean; grantMatches: boolean; originMatches: boolean; referrerPresent: boolean; cookiePresent: boolean; authorizationPresent: boolean; mode: string; released: boolean }[]; providers: { credentialKind: string; referrerPresent: boolean; cookiePresent: boolean }[]; unexpected: number };
const APP = 'http://127.0.0.1:4216';
async function setup(page: Page, mode = 'success', options: Record<string, unknown> = {}) {
  const run = crypto.randomUUID();
  await page.goto(options.unisolated ? '/tests/oauth-unisolated.html' : '/tests/oauth-fixture.html');
  await page.waitForFunction(() => !!(window as any).oauthProof);
  await page.evaluate(value => (window as any).oauthProof.setup(value), { run, mode, ...options });
  expect(await page.evaluate(() => ({ isolated: crossOriginIsolated, secure: isSecureContext }))).toEqual({ isolated: !options.unisolated, secure: true });
  return run;
}
async function openAuthorization(page: Page, context: BrowserContext) {
  const opening = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Connect synthetic provider' }).click();
  const authorization = await opening;
  await authorization.getByRole('button', { name: 'Approve synthetic authorization' }).waitFor();
  expect(await authorization.evaluate(() => ({ origin: location.origin, openerAbsent: window.opener === null }))).toEqual({ origin: 'http://127.0.0.1:4217', openerAbsent: true });
  return authorization;
}
async function approve(authorization: Page) {
  await authorization.getByRole('button', { name: 'Approve synthetic authorization' }).click();
  await authorization.locator('#oauth-status').waitFor();
  expect(await authorization.evaluate(() => ({ origin: location.origin, clean: location.search === '' && location.hash === '', openerAbsent: window.opener === null, isolated: crossOriginIsolated }))).toEqual({ origin: APP, clean: true, openerAbsent: true, isolated: true });
}
async function outcome(page: Page, ok: boolean) {
  await expect.poll(() => page.evaluate(() => (window as any).oauthProof.snapshot().outcome?.ok), { timeout: 18000 }).toBe(ok);
  return page.evaluate(() => (window as any).oauthProof.snapshot().outcome);
}
async function stats(page: Page, run: string): Promise<Stats> { return (await page.request.get('/oauth-fixture/stats/' + run)).json(); }
function validToken(value: Stats) {
  expect(value.tokens).toHaveLength(1);
  expect(value.tokens[0]).toMatchObject({ method: 'POST', codeKnown: true, pkceMatches: true, clientMatches: true, redirectMatches: true, grantMatches: true, originMatches: true, referrerPresent: false, cookiePresent: false, authorizationPresent: false });
  expect(value.unexpected).toBe(0);
}
async function evidence(page: Page, run: string) {
  const wire = await stats(page, run);
  await test.info().attach('redacted-wire', { body: JSON.stringify(wire), contentType: 'application/json' });
  return wire;
}

test('real cross-origin popup, built callback, PKCE, opaque bearer and original-session isolation', async ({ page, context }) => {
  const run = await setup(page), before = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  const capabilities = await page.evaluate(() => (window as any).oauthProof.capabilities());
  expect(capabilities.oauth.available).toBe(true);
  const authorization = await openAuthorization(page, context);
  const callbackResponse = authorization.waitForResponse(value => new URL(value.url()).pathname === '/oauth/callback.html');
  await approve(authorization);
  const headers = (await callbackResponse).headers();
  expect(headers).toMatchObject({ 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  expect(await outcome(page, true)).toMatchObject({ keys: ['binding', 'id', 'persistence'], persistence: 'session' });
  await expect(authorization.locator('#oauth-status')).toHaveText('Authorization received. Return to Quixi to see the connection result.');
  expect(await page.evaluate(() => (window as any).oauthProof.consume())).toBe(200);
  expect(await page.evaluate(() => (window as any).oauthProof.capabilities())).toEqual(capabilities);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).toBe(before);
  const other = await context.newPage(); await other.goto('/tests/oauth-fixture.html'); await other.waitForFunction(() => !!(window as any).oauthProof); await other.evaluate(run => (window as any).oauthProof.setup({ run }), run);
  expect(await other.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false);
  const duplicate = await context.newPage(); await duplicate.goto('http://127.0.0.1:4217/recover/' + run); await approve(duplicate);
  await expect(duplicate.locator('#oauth-status')).toHaveText('This connection request is no longer available. Return to Quixi and start again.');
  const wire = await evidence(page, run); validToken(wire); expect(wire.authorizations).toEqual([expect.objectContaining({ valid: true, referrerPresent: false })]); expect(wire.providers).toEqual([{ credentialKind: 'issued', referrerPresent: false, cookiePresent: false, method: 'GET' }]);
  await page.evaluate(() => (window as any).oauthProof.clearCredential()); expect(await page.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false);
});

for (const mode of ['bad-state', 'bad-issuer', 'bad-path', 'duplicate-query']) test(`${mode} refuses token HTTP and preserves the legitimate pending flow`, async ({ page, context }) => {
  const run = await setup(page, mode), authorization = await openAuthorization(page, context); await approve(authorization);
  await page.waitForTimeout(250); expect((await stats(page, run)).tokens).toHaveLength(0); expect(await page.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false);
  const recovery = await context.newPage(); await recovery.goto('http://127.0.0.1:4217/recover/' + run); await approve(recovery); await outcome(page, true); expect(await page.evaluate(() => (window as any).oauthProof.consume())).toBe(200); validToken(await evidence(page, run));
});

test('issuer-verified denial completes without token exchange', async ({ page, context }) => {
  const run = await setup(page, 'denied'), authorization = await openAuthorization(page, context); await approve(authorization);
  expect(await outcome(page, false)).toMatchObject({ code: 'IO_ERROR' }); await expect(authorization.locator('#oauth-status')).toHaveText('Authorization received. Return to Quixi to see the connection result.'); expect(await page.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false); expect((await evidence(page, run)).tokens).toHaveLength(0);
});

for (const action of ['cancel', 'dispose', 'reload', 'expired']) test(`${action} invalidates a pending flow before its real callback returns`, async ({ page, context }) => {
  const run = await setup(page, 'success', action === 'expired' ? { timeoutMs: 600 } : {}), authorization = await openAuthorization(page, context);
  if (action === 'reload') { await page.reload(); await page.waitForFunction(() => !!(window as any).oauthProof); await page.evaluate(run => (window as any).oauthProof.setup({ run }), run); }
  else if (action === 'expired') await outcome(page, false);
  else { await page.evaluate(action => (window as any).oauthProof[action](), action); await outcome(page, false); }
  await approve(authorization); await expect(authorization.locator('#oauth-status')).toHaveText('This connection request is no longer available. Return to Quixi and start again.');
  if (action === 'dispose') await page.evaluate(run => (window as any).oauthProof.setup({ run }), run);
  expect(await page.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false); expect((await evidence(page, run)).tokens).toHaveLength(0);
});

for (const action of ['cancel', 'dispose', 'manualKey']) test(`${action} during a held real token response prevents a late OAuth credential`, async ({ page, context }) => {
  const run = await setup(page, 'held'), authorization = await openAuthorization(page, context); await approve(authorization);
  await expect.poll(async () => (await stats(page, run)).tokens.length).toBe(1);
  await page.evaluate(action => (window as any).oauthProof[action](), action);
  await page.request.post('/oauth-fixture/release/' + run); await outcome(page, false);
  if (action === 'dispose') await page.evaluate(run => (window as any).oauthProof.setup({ run }), run);
  if (action === 'manualKey') { expect(await page.evaluate(() => (window as any).oauthProof.consume(true))).toBe(200); }
  else expect(await page.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false);
  const wire = await evidence(page, run); validToken(wire); expect(wire.providers.map(value => value.credentialKind)).toEqual(action === 'manualKey' ? ['manual'] : []);
});

for (const mode of ['redirect-token', 'malformed-token', 'oversize-token', 'invalid-token']) test(`${mode} fails after a valid PKCE request without storing credentials`, async ({ page, context }) => {
  const run = await setup(page, mode), authorization = await openAuthorization(page, context); await approve(authorization); expect(await outcome(page, false)).toMatchObject({ code: 'IO_ERROR' }); expect(await page.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false); validToken(await evidence(page, run));
});

test('optional refresh and ID tokens are discarded while the access credential works', async ({ page, context }) => {
  const run = await setup(page, 'auxiliary-tokens'), authorization = await openAuthorization(page, context); await approve(authorization); expect(await outcome(page, true)).toMatchObject({ keys: ['binding', 'id', 'persistence'] }); expect(await page.evaluate(() => (window as any).oauthProof.consume())).toBe(200); validToken(await evidence(page, run));
});

test('empty registry, unavailable channel, invalid requests and popup blocking fail before authorization HTTP', async ({ page, context }) => {
  for (const options of [{ empty: true }, { unavailableChannel: true }, { unisolated: true }, {}]) {
    const run = await setup(page, 'success', options); const capabilities = await page.evaluate(() => (window as any).oauthProof.capabilities());
    if (Object.keys(options).length) expect(capabilities.oauth.available).toBe(false);
    else {
      for (const changes of [{ providerId: 'unknown' }, { configurationId: 'unknown' }, { scopes: ['forbidden'] }]) { await page.evaluate(value => (window as any).oauthProof.start(value), changes); await outcome(page, false); }
      await page.evaluate(() => (window as any).oauthProof.manualKey()); await page.evaluate(() => (window as any).oauthProof.start()); expect(await outcome(page, false)).toMatchObject({ code: 'CONFLICT' }); await page.evaluate(() => (window as any).oauthProof.clearCredential());
      await page.evaluate(() => { window.open = () => null; });
    }
    const before = context.pages().length; await page.getByRole('button', { name: 'Connect synthetic provider' }).click(); await outcome(page, false); expect(context.pages().length).toBe(before); expect((await evidence(page, run)).authorizations).toHaveLength(0);
  }
});

test('callback channel unavailability clears its URL and fails without a token request', async ({ page, context }) => {
  await context.addInitScript(() => { if (location.pathname === '/oauth/callback.html') Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
  const run = await setup(page), authorization = await openAuthorization(page, context); await approve(authorization);
  await expect(authorization.locator('#oauth-status')).toHaveText('This browser could not finish connecting. Return to Quixi and try again.');
  expect((await evidence(page, run)).tokens).toHaveLength(0); await page.evaluate(() => (window as any).oauthProof.cancel()); await outcome(page, false);
});

test('four distinct pending bindings reach the shared bound without a fifth popup or token request', async ({ page, context }) => {
  const run = await setup(page, 'success', { multiple: true });
  for (let index = 0; index < 4; index++) {
    await page.evaluate(index => (window as any).oauthProof.nextConfiguration(index === 0 ? 'synthetic' : `synthetic-${index}`), index);
    await openAuthorization(page, context);
  }
  await page.evaluate(() => (window as any).oauthProof.nextConfiguration('synthetic-4'));
  const before = context.pages().length; await page.getByRole('button', { name: 'Connect synthetic provider' }).click();
  expect(await outcome(page, false)).toMatchObject({ code: 'OVERLOADED' }); expect(context.pages().length).toBe(before);
  await page.evaluate(() => (window as any).oauthProof.dispose());
  const wire = await evidence(page, run); expect(wire.authorizations).toHaveLength(4); expect(wire.tokens).toHaveLength(0);
});

test('history navigation clears the old credential and reconnects in the returned document', async ({ page, context }) => {
  const run = await setup(page); await page.evaluate(() => (window as any).oauthProof.manualKey());
  await page.evaluate(run => { const link = document.createElement('a'); link.href = '/oauth-fixture/away/' + run; link.textContent = 'Leave synthetic proof'; document.body.append(link); }, run);
  await page.getByRole('link', { name: 'Leave synthetic proof' }).click(); await page.waitForLoadState('domcontentloaded'); await page.goBack(); await page.waitForFunction(() => !!(window as any).oauthProof);
  const lifecycle = await page.evaluate(() => (window as any).oauthProof.snapshot().lifecycle);
  await test.info().attach('history-lifecycle', { body: JSON.stringify(lifecycle), contentType: 'application/json' });
  if (lifecycle.restoredFromCache === 0) await page.evaluate(run => (window as any).oauthProof.setup({ run }), run);
  expect(await page.evaluate(() => (window as any).oauthProof.hasCredential())).toBe(false);
  const authorization = await openAuthorization(page, context); await approve(authorization); await outcome(page, true); expect(await page.evaluate(() => (window as any).oauthProof.consume())).toBe(200); validToken(await evidence(page, run));
});
