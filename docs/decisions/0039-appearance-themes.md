# ADR 0039 — Six built-in themes as appearance tokens, independent of interaction settings

Date: 2026-09-12. Status: accepted and implemented.

## Question

Product §92 lists six built-in themes (Warm Reading, Cool Minimal, Compact
Ops, Terminal, Bubbles, Focus) and requires that themes and interaction
behaviour be independent; plan 13 asks for them "through shared appearance
tokens and layouts", with the acceptance criterion that changing a theme
changes no interaction preference and hides no required warning.

## Decision

1. **The stylesheet is tokenized.** Every colour, radius, font and density
   value in `packages/app/src/styles.css` is a custom property on `:root`
   (`--text`, `--bg`, `--surface`, `--border-*`, `--accent*`, `--warn-*`,
   `--danger-*`, `--focus`, `--radius-*`, `--font-*`, `--message-*`,
   `--workspace-max`). The default values are the existing palette, which
   is the Warm Reading theme; no literal colour remains outside the token
   definitions (asserted by the transformation that produced the file).
2. **A theme is a `data-theme` attribute on the document root** whose block
   overrides tokens and, where the theme needs it, a few layout rules:
   Cool Minimal (cool greys and blue accent, smaller radii); Compact Ops
   (14px type, tight spacing, square corners, wide workspace); Terminal
   (dark scheme, monospace body type, minimal radii, `color-scheme: dark`);
   Bubbles (large radii, user messages right-aligned at 82% width);
   Focus (near-monochrome, 760px measure, 1.7 line height, borderless
   messages). Every theme keeps body and muted text at 4.5:1 or better
   against its page background (measured in the proof).
3. **The theme is a device-local preference** next to the interaction
   settings: `LocalPreferences` version 4 adds `theme`, with a dedicated
   `setTheme` operation and the same conditional-revision write; rows from
   versions 1–3 normalize to version 4 with the default theme. The
   Preferences panel gets a Theme select beside the interaction controls,
   and `AppRoot` mirrors the preference onto the root element. Changing the
   theme writes only `theme` and the revision; interaction preferences are
   untouched by construction and by proof.
4. **Required notices are not themed away**: alerts, statuses and warnings
   keep their roles and their tokens (`--warn-*`, `--danger-*`) are
   defined for every theme, including the dark one.

## Evidence

The shared-app proof switches through all six themes and asserts the root
attribute, six distinct page backgrounds, body and muted contrast ≥ 4.5:1,
a monospace body font under Terminal, unchanged interaction preferences
(revision aside) and the visible saved-status region; the preference
contract, storage and canonical suites cover the version-4 shape and the
v1–v3 normalization. See [interaction-preferences.md](../validation/interaction-preferences.md).
