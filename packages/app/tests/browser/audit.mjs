import { expect } from "@playwright/test";

/** A bounded, self-contained accessibility audit of the current view (plan 13):
 * accessible names on every control, contrast of visible text against its
 * effective background, landmark and heading structure, focus-visible
 * outlines on controls, non-colour status text, and live-region hygiene.
 * It is a DOM/computed-style audit in real engines, not assistive-technology
 * delivery, which stays a release qualification item. */
export async function auditView(page, view, options = {}) {
  const report = await page.evaluate(({ view, allow }) => {
    const out = { view, controls: 0, unnamed: [], textNodes: 0, contrast: [], landmarks: [], duplicateLandmarks: [], headings: [], headingSkips: [], liveInsideMessages: 0, statusWithoutText: [], focusChecked: 0, focusWithoutOutline: [] };
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const name = (el) => {
      const aria = el.getAttribute("aria-label"); if (aria && aria.trim()) return aria.trim();
      const by = el.getAttribute("aria-labelledby"); if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim(); if (t) return t; }
      if (el.labels && el.labels.length) { const t = [...el.labels].map((l) => l.textContent).join(" ").trim(); if (t) return t; }
      if (el.closest("label") && el.closest("label").textContent.trim()) return el.closest("label").textContent.trim();
      const title = el.getAttribute("title"); if (title && title.trim()) return title.trim();
      if (el.tagName === "INPUT" && ["submit", "button"].includes(el.type) && el.value) return el.value;
      if (el.tagName === "IMG") return el.getAttribute("alt") ?? "";
      const t = (el.textContent ?? "").trim(); return t;
    };
    // 1. Controls need an accessible name.
    for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], summary, img")) {
      if (!visible(el)) continue;
      out.controls++;
      const n = name(el);
      if (!n && !(el.tagName === "IMG" && el.getAttribute("alt") === "")) out.unnamed.push({ tag: el.tagName, id: el.id, className: String(el.className).slice(0, 60) });
    }
    // 2. Contrast of visible text against the effective background.
    const parse = (c) => { const m = c.match(/[\d.]+/g)?.map(Number) ?? []; return { r: m[0] ?? 0, g: m[1] ?? 0, b: m[2] ?? 0, a: m.length > 3 ? m[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const background = (el) => { let node = el, acc = null; while (node && node !== document.documentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c.a > 0) acc = acc ? blend(acc, c) : c; if (acc && acc.a >= 1) return acc; node = node.parentElement; } const root = parse(getComputedStyle(document.documentElement).backgroundColor); return acc ? blend(acc, root.a > 0 ? root : { r: 255, g: 255, b: 255, a: 1 }) : (root.a > 0 ? root : { r: 255, g: 255, b: 255, a: 1 }); };
    const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim(); if (!text) continue;
      const el = node.parentElement; if (!el || seen.has(el) || !visible(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (el.closest("[disabled], [aria-disabled=true]") || el.closest(".visually-hidden") || (el.tagName === "OPTION")) continue;
      const fg = parse(cs.color); if (fg.a === 0) continue;
      const bg = background(el);
      const r = ratio(blend(fg, bg), bg);
      const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      out.textNodes++;
      const needed = large ? 3 : 4.5;
      if (r < needed && !allow.some((sel) => el.matches(sel) || el.closest(sel))) out.contrast.push({ text: text.slice(0, 40), ratio: Number(r.toFixed(2)), needed, color: cs.color, background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`, tag: el.tagName, className: String(el.className).slice(0, 50) });
    }
    // 3. Landmarks: unique names among same-role landmarks.
    const landmarkRoles = { main: "main", nav: "navigation", aside: "complementary", header: "banner", footer: "contentinfo", form: "form", section: "region" };
    const keys = new Map();
    for (const el of document.querySelectorAll("main, nav, aside, header, footer, form, section, [role=main], [role=navigation], [role=complementary], [role=region], [role=search], [role=form]")) {
      if (!visible(el)) continue;
      const role = el.getAttribute("role") ?? landmarkRoles[el.tagName.toLowerCase()];
      const n = el.getAttribute("aria-label") ?? (el.getAttribute("aria-labelledby") ? document.getElementById(el.getAttribute("aria-labelledby"))?.textContent?.trim() : null);
      if (role === "region" && !n) continue; // an unnamed section is not a landmark
      if (role === "form" && !n) continue;
      out.landmarks.push({ role, name: n ?? null });
      const key = `${role}|${n ?? ""}`; keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    for (const [key, count] of keys) if (count > 1 && !key.endsWith("|")) out.duplicateLandmarks.push({ key, count });
    // 4. Heading order (no skipped levels among visible headings).
    let last = 0;
    for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) { if (!visible(h)) continue; const level = Number(h.tagName[1]); out.headings.push({ level, text: h.textContent.trim().slice(0, 40) }); if (last && level > last + 1) out.headingSkips.push({ from: last, to: level, text: h.textContent.trim().slice(0, 40) }); last = level; }
    // 5. No live region inside the message list (streaming announcements are controlled elsewhere).
    out.liveInsideMessages = document.querySelectorAll(".messages [aria-live], .messages [role=status], .messages [role=alert]").length;
    // 6. Alerts carry text, not colour alone. Empty polite status regions are
    // permitted placeholders: a live region must exist before its text changes
    // for the change to be announced (the generation status is one).
    out.emptyStatusPlaceholders = [...document.querySelectorAll("[role=status]")].filter((el) => visible(el) && !(el.textContent ?? "").trim()).length;
    for (const el of document.querySelectorAll("[role=alert]")) { if (!visible(el)) continue; if (!(el.textContent ?? "").trim()) out.statusWithoutText.push({ tag: el.tagName, className: String(el.className).slice(0, 50) }); }
    return out;
  }, { view, allow: options.allowContrast ?? [] });
  // 7. Focus visibility: the first few focusable controls show a solid outline
  // when focused via keyboard. Off by default because it moves focus; callers
  // that are not mid-flow opt in, and the previously focused element is restored.
  const focusables = page.locator("button:visible, a[href]:visible, input:visible, select:visible, textarea:visible");
  const count = Math.min(await focusables.count(), options.focusSamples ?? 0);
  const previous = count ? await page.evaluateHandle(() => document.activeElement) : null;
  for (let i = 0; i < count; i++) {
    const el = focusables.nth(i);
    try {
      await el.focus();
      const outline = await el.evaluate((node) => { node.dispatchEvent(new Event("keydown")); const cs = getComputedStyle(node); return { style: cs.outlineStyle, width: cs.outlineWidth, matches: node.matches(":focus-visible") }; });
      report.focusChecked++;
      // focus() from script may not set :focus-visible in every engine; only count a clear miss when it does match.
      if (outline.matches && (outline.style === "none" || parseFloat(outline.width) === 0)) report.focusWithoutOutline.push(await el.evaluate((node) => ({ tag: node.tagName, text: (node.textContent ?? "").trim().slice(0, 30) })));
    } catch { /* detached during the check */ }
  }
  if (previous) await previous.evaluate((node) => { if (node instanceof HTMLElement && node !== document.body) node.focus(); else if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  expect(report.unnamed, `${view}: unnamed controls`).toEqual([]);
  expect(report.contrast, `${view}: contrast below 4.5:1`).toEqual([]);
  expect(report.duplicateLandmarks, `${view}: duplicate landmark names`).toEqual([]);
  expect(report.headingSkips, `${view}: skipped heading levels`).toEqual([]);
  expect(report.liveInsideMessages, `${view}: live regions inside the message list`).toBe(0);
  expect(report.statusWithoutText, `${view}: empty alert regions`).toEqual([]);
  expect(report.focusWithoutOutline, `${view}: focused controls without an outline`).toEqual([]);
  return report;
}
