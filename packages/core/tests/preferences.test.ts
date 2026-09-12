import test from "node:test";
import assert from "node:assert/strict";
import { assertInteractionPreferences, assertLocalPreferences, assertPreferenceArgs, assertStorageRequest,
  DEFAULT_LOCAL_PREFERENCES, normalizeLocalPreferences } from "../src/contracts/index.ts";
import type { InteractionPreferences, StorageRequest } from "../src/contracts/index.ts";

const preferences: InteractionPreferences = {
  showTimestamps: true, showModelBadges: false, composerLayout: "compact", modelSwitcherStyle: "list",
};

test("closed v1 preferences normalize to v2 without mutating input or shared defaults", () => {
  const legacy = Object.freeze({ version: 1, revision: 12, sendKey: "enter" });
  const value = normalizeLocalPreferences(legacy);
  assert.deepEqual(value, { ...DEFAULT_LOCAL_PREFERENCES, revision: 12, sendKey: "enter" });
  assert.deepEqual(legacy, { version: 1, revision: 12, sendKey: "enter" });
  value.showTimestamps = true;
  assert.equal(DEFAULT_LOCAL_PREFERENCES.showTimestamps, false);
  assert.throws(() => assertLocalPreferences(legacy), /preserved/);
});

test("closed v2 and v3 preferences normalize to v4 (onboarding once for v2, default theme for both), without mutating input", () => {
  const stored = Object.freeze({ version: 2, revision: 4, sendKey: "enter", ...preferences });
  const value = normalizeLocalPreferences(stored);
  assert.deepEqual(value, { ...DEFAULT_LOCAL_PREFERENCES, ...preferences, revision: 4, sendKey: "enter", version: 4, onboardingCompletedAt: null, theme: "warm-reading" });
  const storedV3 = Object.freeze({ version: 3, revision: 9, sendKey: "enter", ...preferences, onboardingCompletedAt: 1_700_000_000_000 });
  assert.deepEqual(normalizeLocalPreferences(storedV3), { ...DEFAULT_LOCAL_PREFERENCES, ...preferences, revision: 9, sendKey: "enter", version: 4, onboardingCompletedAt: 1_700_000_000_000, theme: "warm-reading" });
  assert.equal((storedV3 as { theme?: unknown }).theme, undefined);
  assert.throws(() => assertLocalPreferences(storedV3), /preserved/);
  assert.doesNotThrow(() => assertPreferenceArgs("setTheme", { expectedRevision: 9, theme: "terminal" }));
  for (const args of [{ expectedRevision: 9, theme: "neon" }, { expectedRevision: 9 }, { expectedRevision: 9, theme: "focus", extra: 1 }])
    assert.throws(() => assertPreferenceArgs("setTheme", args));
  assert.equal((stored as { onboardingCompletedAt?: unknown }).onboardingCompletedAt, undefined);
  assert.throws(() => assertLocalPreferences(stored), /preserved/);
  assert.doesNotThrow(() => assertPreferenceArgs("setOnboardingState", { expectedRevision: 4, onboardingCompletedAt: 1_700_000_000_000 }));
  assert.doesNotThrow(() => assertPreferenceArgs("setOnboardingState", { expectedRevision: 4, onboardingCompletedAt: null }));
  for (const args of [{ expectedRevision: 4, onboardingCompletedAt: -1 }, { expectedRevision: 4, onboardingCompletedAt: "now" }, { expectedRevision: 4 }, { expectedRevision: 4, onboardingCompletedAt: null, extra: 1 }])
    assert.throws(() => assertPreferenceArgs("setOnboardingState", args));
});

test("v4 preferences are closed and copied, and an old closed v1 reader refuses expanded results", () => {
  const value = { ...DEFAULT_LOCAL_PREFERENCES, ...preferences, revision: 7 };
  assert.doesNotThrow(() => assertLocalPreferences(value));
  const copy = normalizeLocalPreferences(value);
  assert.deepEqual(copy, value); assert.notEqual(copy, value);
  // The previous reader accepted exactly version/revision/sendKey at version 1.
  const oldReaderAccepts = (row: Record<string, unknown>) => Object.keys(row).length === 3 && row.version === 1;
  assert.equal(oldReaderAccepts(value), false);
  for (const invalid of [null, [], {}, { ...value, version: 5 }, { ...value, future: true }, { ...value, onboardingCompletedAt: -5 }, { ...value, theme: "neon" },
    { ...value, revision: -1 }, { ...value, revision: Number.MAX_SAFE_INTEGER },
    { ...value, sendKey: "unknown" }, { ...value, showTimestamps: 1 },
    { ...value, composerLayout: "tiny" }, { ...value, modelSwitcherStyle: "radio" },
    { version: 1, revision: 0, sendKey: "enter", showTimestamps: false }]) {
    assert.throws(() => normalizeLocalPreferences(invalid), /preserved/);
  }
});

test("interaction preferences reject omissions, extra keys and wrong scalar types", () => {
  assert.doesNotThrow(() => assertInteractionPreferences(preferences));
  for (const key of Object.keys(preferences)) {
    const missing: Record<string, unknown> = { ...preferences }; delete missing[key];
    assert.throws(() => assertInteractionPreferences(missing));
  }
  for (const value of [null, [], { ...preferences, extra: false }, { ...preferences, showModelBadges: "false" },
    { ...preferences, showTimestamps: null }, { ...preferences, composerLayout: "dense" },
    { ...preferences, modelSwitcherStyle: "menu" }]) assert.throws(() => assertInteractionPreferences(value));
});

test("interaction writes validate the full closed payload at the storage boundary", () => {
  const request = { version: 1, requestId: crypto.randomUUID(), operation: "setInteractionPreferences",
    args: { expectedRevision: 0, preferences } } as const;
  assert.doesNotThrow(() => assertStorageRequest(request));
  for (const args of [null, {}, { expectedRevision: -1, preferences }, { expectedRevision: 0.5, preferences },
    { expectedRevision: Number.MAX_SAFE_INTEGER - 1, preferences },
    { expectedRevision: 0, preferences, sendKey: "enter" }, { expectedRevision: 0, preferences: { ...preferences, sendKey: "enter" } }]) {
    assert.throws(() => assertStorageRequest({ ...request, args } as StorageRequest));
  }
  assert.throws(() => assertPreferenceArgs("unknown" as "setInteractionPreferences", { expectedRevision: 0, preferences }));
  assert.throws(() => assertStorageRequest({ ...request, operation: "setUnknownPreferences" } as unknown as StorageRequest), /Unknown storage operation/);
});
