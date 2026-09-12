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

test("v2 preferences are closed and copied, and an old closed v1 reader refuses expanded results", () => {
  const value = { ...DEFAULT_LOCAL_PREFERENCES, ...preferences, revision: 7 };
  assert.doesNotThrow(() => assertLocalPreferences(value));
  const copy = normalizeLocalPreferences(value);
  assert.deepEqual(copy, value); assert.notEqual(copy, value);
  // The previous reader accepted exactly version/revision/sendKey at version 1.
  const oldReaderAccepts = (row: Record<string, unknown>) => Object.keys(row).length === 3 && row.version === 1;
  assert.equal(oldReaderAccepts(value), false);
  for (const invalid of [null, [], {}, { ...value, version: 3 }, { ...value, future: true },
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
