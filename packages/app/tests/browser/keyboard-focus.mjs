import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

export async function keyboardActivate(control) {
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await control.press('Enter');
}

async function preferenceFocusState(page) {
  return page.evaluate(() => {
    const control = document.getElementById('send-key-preference');
    return { documentFocused: document.hasFocus(), activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id, controlFocused: document.activeElement === control, disabled: control.disabled, value: control.value };
  });
}

async function exerciseWindowFocusReturn(page, control, name) {
  const evidence = { scope: 'Emulated document.hasFocus, window focus events and explicit origin.blur(); real DOM disabling, production preference controller and durable StorageWorker write.', stages: [] };
  const capture = async stage => evidence.stages.push({ stage, ...await preferenceFocusState(page) });
  const before = await page.evaluate(() => window.appAcceptance.preferences());
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await expect(control).toHaveValue('mod-enter');
  await capture('focused-before-mutation');
  expect(await preferenceFocusState(page)).toMatchObject({ documentFocused: true, controlFocused: true, disabled: false });
  await page.evaluate(() => {
    window.keyboardOriginalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    window.dispatchEvent(new Event('blur'));
    window.appAcceptance.holdPreferenceReply();
  });
  try {
    expect(await page.evaluate(() => document.hasFocus())).toBe(false);
    await expect(control).toBeEnabled();
    await expect(control).toBeFocused();
    await control.selectOption('enter');
    await expect(control).toBeDisabled();
    await capture('disabled-before-emulated-origin-blur');
    await control.evaluate(node => node.blur());
    await capture('disabled-while-document-unfocused');
    expect(await preferenceFocusState(page)).toMatchObject({ documentFocused: false, controlFocused: false, activeTag: 'BODY', disabled: true });
    await page.evaluate(() => window.appAcceptance.releasePreferenceReply());
    await expect(control).toBeEnabled();
    await expect(control).toHaveValue('enter');
    await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
    await capture('saved-while-document-unfocused');
    expect(await preferenceFocusState(page)).toMatchObject({ documentFocused: false, controlFocused: false, activeTag: 'BODY', disabled: false, value: 'enter' });
    const saved = await page.evaluate(() => window.appAcceptance.preferences());
    expect(saved).toEqual({ ...before, revision: before.revision + 1, sendKey: 'enter' });
    await page.evaluate(() => {
      const descriptor = window.keyboardOriginalHasFocus;
      if (descriptor) Object.defineProperty(document, 'hasFocus', descriptor);
      else delete document.hasFocus;
      delete window.keyboardOriginalHasFocus;
      window.dispatchEvent(new Event('focus'));
    });
    await expect(control).toBeFocused();
    await capture('original-control-restored-on-window-return');
    expect(await preferenceFocusState(page)).toMatchObject({ documentFocused: true, controlFocused: true, disabled: false, value: 'enter' });

    // Remembering an origin alone is not permission to focus it on return.
    // This second blur has no disabled/removed interval and performs no save.
    await expect(control).toBeEnabled();
    await expect(control).toBeFocused();
    await page.evaluate(() => {
      window.keyboardOriginalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
      window.dispatchEvent(new Event('blur'));
      document.getElementById('send-key-preference').blur();
    });
    await capture('enabled-origin-blurred-without-mutation');
    expect(await preferenceFocusState(page)).toMatchObject({ documentFocused: false, controlFocused: false, activeTag: 'BODY', disabled: false });
    await page.evaluate(async () => {
      const descriptor = window.keyboardOriginalHasFocus;
      if (descriptor) Object.defineProperty(document, 'hasFocus', descriptor);
      else delete document.hasFocus;
      delete window.keyboardOriginalHasFocus;
      window.dispatchEvent(new Event('focus'));
      await new Promise(resolve => queueMicrotask(resolve));
    });
    await capture('window-return-does-not-focus-uninterrupted-origin');
    expect(await preferenceFocusState(page)).toMatchObject({ documentFocused: true, controlFocused: false, activeTag: 'BODY', disabled: false, value: 'enter' });
    expect(await page.evaluate(() => window.appAcceptance.preferences())).toEqual(saved);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error);
    await capture('failure');
    throw error;
  } finally {
    await page.evaluate(() => {
      if (Object.hasOwn(window, 'keyboardOriginalHasFocus')) {
        const descriptor = window.keyboardOriginalHasFocus;
        if (descriptor) Object.defineProperty(document, 'hasFocus', descriptor);
        else delete document.hasFocus;
        delete window.keyboardOriginalHasFocus;
        window.dispatchEvent(new Event('focus'));
      }
      window.appAcceptance.releasePreferenceReply();
    });
    await writeFile(`test-results/keyboard-focus-${name}-window-return.json`, JSON.stringify(evidence, null, 2));
  }
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await control.selectOption('mod-enter');
  await expect(control).toHaveValue('mod-enter');
  await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
  await expect(control).toBeFocused();
}

export async function observeProgress(page, className) {
  await page.evaluate(className => {
    const entries = [];
    const capture = () => {
      for (const phase of document.querySelectorAll(`.${className}`)) {
        const entry = { text: phase.textContent?.trim(), role: phase.getAttribute('role'), atomic: phase.getAttribute('aria-atomic'), parentLive: !!phase.parentElement?.closest('[role="status"],[role="alert"],[aria-live="polite"],[aria-live="assertive"]') };
        if (!entry.text) continue;
        if (JSON.stringify(entries.at(-1)) !== JSON.stringify(entry) && entries.length < 32) entries.push(entry);
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['role', 'aria-atomic', 'aria-live'] });
    capture();
    window.keyboardProgressEvidence = { entries, observer, capture };
  }, className);
}

export async function verifyProgress(page) {
  const entries = await page.evaluate(() => {
    const evidence = window.keyboardProgressEvidence;
    evidence.capture(); evidence.observer.disconnect();
    delete window.keyboardProgressEvidence;
    return evidence.entries;
  });
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.length).toBeLessThan(32);
  for (const entry of entries) {
    expect(entry.role).toBe('status');
    expect(entry.atomic).toBe('true');
    expect(entry.parentLive).toBe(false);
    expect(entry.text).toBeTruthy();
    expect(entry.text).not.toMatch(/\d/);
  }
  return entries.map(entry => entry.text);
}

export async function exercisePreferenceFocus({ page, name }) {
  try {
    await keyboardActivate(page.getByRole('button', { name: 'Preferences', exact: true }));
    const control = page.getByLabel('Send key', { exact: true });
    await expect(control).toHaveValue('mod-enter');
    await expect(control).toBeEnabled();
    await control.focus();
    await expect(control).toBeFocused();
    // macOS headless native select popups do not consistently commit synthetic
    // arrow keys. Keep focus explicit and use the browser's option action.
    await control.selectOption('enter');
    await expect(control).toHaveValue('enter');
    await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
    await expect(control).toBeEnabled();
    await expect(control).toBeFocused();
    await control.selectOption('mod-enter');
    await expect(control).toHaveValue('mod-enter');
    await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
    await expect(control).toBeFocused();
    const checkbox = page.getByLabel('Show message timestamps', { exact: true });
    await expect(checkbox).toBeEnabled();
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
    await expect(checkbox).toBeEnabled();
    await expect(checkbox).toBeFocused();
    await checkbox.press('Space');
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
    await expect(checkbox).toBeFocused();
    await exerciseWindowFocusReturn(page, control, name);
    await exerciseParkedHeadingBlur(page, control, name);

    // Delay only the fixture reply after the real durable operation. This
    // makes the period with disabled controls deterministic without slowing
    // or replacing storage or changing the production operation.
    await page.evaluate(() => window.appAcceptance.holdPreferenceReply());
    try {
      await expect(control).toBeEnabled();
      await control.focus();
      await expect(control).toBeFocused();
      await control.selectOption('enter');
      await expect(control).toBeDisabled();
      for (let step = 0; step < 16; step++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate(() => document.activeElement !== document.body && !document.querySelector('section[aria-label="Preferences"]')?.contains(document.activeElement))) break;
      }
      const external = await page.locator(':focus').elementHandle();
      expect(external).not.toBeNull();
      expect(await external.evaluate(node => node !== document.body && !document.querySelector('section[aria-label="Preferences"]')?.contains(node))).toBe(true);
      await page.evaluate(() => window.appAcceptance.releasePreferenceReply());
      await expect(control).toBeEnabled();
      await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
      expect(await external.evaluate(node => document.activeElement === node)).toBe(true);
      await external.dispose();
    } finally { await page.evaluate(() => window.appAcceptance.releasePreferenceReply()); }
    await expect(control).toBeEnabled();
    await control.focus();
    await expect(control).toBeFocused();
    await control.selectOption('mod-enter');
    await expect(control).toHaveValue('mod-enter');
    await expect(control).toBeFocused();
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(control).toBeFocused();
    await page.screenshot({ path: `test-results/keyboard-focus-${name}-preferences-enlarged.png`, fullPage: true });
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize(viewport);
    await keyboardActivate(page.getByRole('button', { name: 'Library', exact: true }));
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      active: document.activeElement ? { tag: document.activeElement.tagName, id: document.activeElement.id, role: document.activeElement.getAttribute('role'), label: document.activeElement.getAttribute('aria-label'), html: document.activeElement.outerHTML.slice(0, 1024) } : null,
      control: document.getElementById('send-key-preference')?.outerHTML,
      headings: [...document.querySelectorAll('h1,h2')].slice(0, 16).map(node => node.textContent),
      status: [...document.querySelectorAll('[role="status"],[role="alert"]')].slice(0, 16).map(node => node.textContent?.slice(0, 256)),
    }));
    await writeFile(`test-results/keyboard-focus-${name}-failure.json`, JSON.stringify({ error: String(error), ...diagnostic }, null, 2));
    await page.screenshot({ path: `test-results/keyboard-focus-${name}-failure.png`, fullPage: true });
    throw error;
  }
}

async function exerciseParkedHeadingBlur(page, control, name) {
  const evidence = { scope: 'Real preference save with one test-only held reply; explicit blur of the parked heading, without an external focusin event.', stages: [] };
  const capture = async stage => evidence.stages.push({ stage, ...await page.evaluate(() => {
    const input = document.getElementById('send-key-preference');
    const active = document.activeElement;
    return { documentFocused: document.hasFocus(), activeTag: active?.tagName, activeId: active?.id, activeText: active === document.body ? null : active?.textContent?.slice(0, 128), controlDisabled: input.disabled, value: input.value };
  }) });
  const before = await page.evaluate(() => window.appAcceptance.preferences());
  expect(before.sendKey).toBe('mod-enter');
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await page.evaluate(() => window.appAcceptance.holdPreferenceReply());
  try {
    await control.selectOption('enter');
    await expect(control).toBeDisabled();
    const heading = page.getByRole('heading', { name: 'Preferences', exact: true });
    await expect(heading).toBeFocused();
    await capture('save-pending-focus-parked-on-heading');
    await heading.evaluate(node => node.blur());
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await capture('parked-heading-explicitly-blurred');
    await page.evaluate(() => window.appAcceptance.releasePreferenceReply());
    await expect(control).toBeEnabled();
    await expect(control).toHaveValue('enter');
    await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
    await capture('save-completed-after-heading-blur');
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    const saved = await page.evaluate(() => window.appAcceptance.preferences());
    expect(saved).toEqual({ ...before, revision: before.revision + 1, sendKey: 'enter' });
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error);
    await capture('failure');
    throw error;
  } finally {
    await page.evaluate(() => window.appAcceptance.releasePreferenceReply());
    await writeFile(`test-results/keyboard-focus-${name}-parked-heading-blur.json`, JSON.stringify(evidence, null, 2));
  }
  // A new, explicit user focus starts the next interaction; no replayed action.
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await control.selectOption('mod-enter');
  await expect(control).toHaveValue('mod-enter');
  await expect(page.getByText('Preferences are saved on this device.', { exact: true })).toBeVisible();
  await expect(control).toBeFocused();
}
