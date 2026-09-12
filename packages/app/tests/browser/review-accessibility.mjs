import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

export async function keyboardReviewAction({ control, focusAfter }) {
  await expect(control).toBeEnabled();
  await control.focus();
  await expect(control).toBeFocused();
  await control.press('Enter');
  if (focusAfter) await expect(focusAfter).toBeFocused();
}

async function measureReview(region) {
  return region.evaluate(root => {
    const rounded = value => Math.round(value * 100) / 100;
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { left: rounded(box.left), right: rounded(box.right), width: rounded(box.width), height: rounded(box.height) };
    };
    const color = text => {
      const match = /^rgba?\(([^)]+)\)$/.exec(text);
      if (!match) return null;
      const channels = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (channels.length < 3 || channels.some(value => !Number.isFinite(value))) return null;
      return [...channels.slice(0, 3), channels[3] ?? 1];
    };
    const over = (foreground, background) => foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
    const background = node => {
      const layers = [];
      for (let current = node; current; current = current.parentElement) {
        const layer = color(getComputedStyle(current).backgroundColor);
        if (!layer) return null;
        layers.push(layer);
      }
      return layers.reverse().reduce((result, layer) => over(layer, result), [255, 255, 255]);
    };
    const luminance = rgb => rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const ratio = (left, right) => {
      const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const label = node => (node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.textContent || node.tagName).trim().slice(0, 160);
    const visible = node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden'; };
    const controls = [...root.querySelectorAll('input,select,textarea,button,fieldset')].filter(visible).slice(0, 96).map(node => {
      const bounds = rect(node), container = node.closest('fieldset,form') ?? root;
      const containerBounds = rect(container);
      return { tag: node.tagName, label: label(node), bounds, containerBounds, disabled: node.matches(':disabled'), overflow: bounds.left < -1 || bounds.right > innerWidth + 1 || bounds.width > innerWidth + 1 || (container !== node && (bounds.left < containerBounds.left - 1 || bounds.right > containerBounds.right + 1)) };
    });
    // Check the solid CSS boundary of enabled text/select controls. Native
    // checkbox/radio painting and screenshots are not pixel-sampled here.
    const borders = [...root.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),select,textarea')].filter(node => visible(node) && !node.matches(':disabled')).slice(0, 32).map(node => {
      const style = getComputedStyle(node), fill = background(node), outside = background(node.parentElement);
      const sides = ['Top', 'Right', 'Bottom', 'Left'].map(side => {
        const raw = style[`border${side}Color`], parsed = color(raw), width = parseFloat(style[`border${side}Width`]), borderStyle = style[`border${side}Style`];
        const painted = parsed && fill ? over(parsed, fill) : null;
        return { side, color: raw, width, style: borderStyle, fillContrast: painted && fill ? ratio(painted, fill) : null, outsideContrast: painted && outside ? ratio(painted, outside) : null };
      });
      return { label: label(node), fill, outside, sides };
    });
    const active = document.activeElement;
    return {
      viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      region: rect(root), rootFontSize: getComputedStyle(document.documentElement).fontSize,
      focused: active ? { tag: active.tagName, id: active.id, label: active === document.body ? 'BODY' : label(active), insideRegion: root.contains(active) } : null,
      controlCount: controls.length, controls, borders,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 ? [...document.querySelectorAll('body *')].slice(0, 2000).filter(node => {
        const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== 'hidden' && (bounds.right > innerWidth + 1 || style.overflowX === 'visible' && node.scrollWidth > node.clientWidth + 1);
      }).slice(0, 40).map(node => ({ tag: node.tagName, id: node.id, className: node.className, label: label(node), bounds: rect(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, overflowX: getComputedStyle(node).overflowX })) : [],
    };
  });
}

function violations(measurement, requireBorders) {
  const failures = [];
  if (measurement.documentWidth > measurement.viewportWidth + 1) failures.push('Document overflows the viewport');
  for (const control of measurement.controls) if (control.overflow) failures.push(`Control overflows: ${control.label}`);
  if (requireBorders && !measurement.borders.length) failures.push('No enabled text/select control border was measured');
  for (const border of measurement.borders) {
    for (const side of border.sides) {
      if (side.width <= 0 || side.style === 'none' || side.style === 'hidden' || side.fillContrast === null || side.outsideContrast === null || side.fillContrast < 3 || side.outsideContrast < 3) failures.push(`Control boundary below 3:1 or unmeasurable: ${border.label} (${side.side})`);
    }
  }
  return failures;
}

/** mode=capture records baseline failures without treating them as a pass. */
export async function captureReviewLayout({ page, regionName, name, caseName, mode = 'assert', requireBorders = false, role = 'region' }) {
  if (!['capture', 'assert'].includes(mode)) throw new Error('Unknown review accessibility capture mode');
  if (!/^[a-z0-9-]{1,64}$/.test(caseName) || !/^[a-z0-9-]{1,32}$/.test(name)) throw new Error('Invalid bounded review artifact name');
  const region = page.getByRole(role, { name: regionName, exact: true });
  await expect(region).toBeVisible();
  const viewport = page.viewportSize();
  const original = await page.evaluate(() => ({ fontSize: document.documentElement.style.fontSize, scrollX, scrollY }));
  const report = { mode, name, caseName, scope: 'Computed CSS reflow and enabled control-border contrast; no screen-reader or native-control pixel-rendering qualification.', samples: [] };
  try {
    for (const [size, fontSize] of [['normal', original.fontSize], ['enlarged', '200%']]) {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.evaluate(fontSize => { document.documentElement.style.fontSize = fontSize; }, fontSize);
      await region.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const measurement = await measureReview(region);
      report.samples.push({ size, ...measurement, violations: violations(measurement, requireBorders) });
      await page.screenshot({ path: `test-results/review-accessibility-${name}-${caseName}-${size}.png`, fullPage: true });
      await page.screenshot({ path: `test-results/review-accessibility-${name}-${caseName}-${size}-viewport.png` });
    }
    report.status = report.samples.some(sample => sample.violations.length) ? 'failed' : 'passed';
  } finally {
    await page.evaluate(value => { document.documentElement.style.fontSize = value.fontSize; }, original);
    if (viewport) await page.setViewportSize(viewport);
    await page.evaluate(value => scrollTo(value.scrollX, value.scrollY), original);
    await writeFile(`test-results/review-accessibility-${name}-${caseName}.json`, JSON.stringify(report, null, 2));
  }
  if (mode === 'assert') expect(report.samples.flatMap(sample => sample.violations.map(value => `${sample.size}: ${value}`))).toEqual([]);
  return report;
}

export async function exerciseAliasReflow({ page, name, mode = 'assert' }) {
  const registry = await page.evaluate(() => window.appAcceptance.aliases());
  const activate = async control => mode === 'capture' ? control.click() : keyboardReviewAction({ control });
  await activate(page.getByRole('button', { name: 'Preferences', exact: true }));
  await activate(page.getByRole('button', { name: 'New routing alias', exact: true }));
  const editor = page.getByRole('form', { name: 'Routing alias editor', exact: true });
  await expect(editor).toBeVisible();
  try {
    await editor.getByLabel('Alias name', { exact: true }).fill(`SyntheticRoutingAlias_${'x'.repeat(64)}`.slice(0, 64));
    const primary = editor.getByLabel('Alias primary', { exact: true });
    const options = await primary.locator('option').evaluateAll(nodes => nodes.filter(node => node.value && !node.disabled && JSON.parse(node.value)[0]).map(node => node.value).slice(0, 16));
    // The initial screen may have no connection; later flow also measures a
    // populated editor with a configured and an unavailable fallback.
    if (options.length) await primary.selectOption(options[0]);
    if (options.length > 1) {
      await editor.getByLabel('Alias fallback candidate', { exact: true }).selectOption(options[1]);
      await activate(editor.getByRole('button', { name: 'Add alias fallback', exact: true }));
    }
    // Measure ordinary borders, not a focused control's outline.
    const cancel = editor.getByRole('button', { name: 'Cancel alias edit', exact: true });
    await cancel.focus();
    if (mode === 'assert') await expect(cancel).toBeFocused();
    if (mode === 'capture' && process.env.QUIXI_TEST_NATIVE_SELECT_DIAGNOSTIC === '1') {
      for (const [caseName, rule] of [['select-overflow', 'overflow: hidden'], ['select-appearance', 'appearance: none; -webkit-appearance: none'], ['select-containment', 'contain: inline-size']]) {
        const style = await page.addStyleTag({ content: `.routing-alias-editor select { ${rule} }` });
        try { await captureReviewLayout({ page, regionName: 'Routing alias editor', role: 'form', name, caseName, mode: 'capture', requireBorders: true }); }
        finally { await style.evaluate(node => node.remove()); }
      }
    }
    return await captureReviewLayout({ page, regionName: 'Routing alias editor', role: 'form', name, caseName: 'alias-editor', mode, requireBorders: true });
  } finally {
    await activate(editor.getByRole('button', { name: 'Cancel alias edit', exact: true }));
    await expect(editor).toHaveCount(0);
    expect(await page.evaluate(() => window.appAcceptance.aliases())).toEqual(registry);
    await activate(page.getByRole('button', { name: 'Library', exact: true }));
  }
}
