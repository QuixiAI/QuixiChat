import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCAL_PREFERENCES } from "@quixi/core/contracts";
import type { InteractionPreferences, LocalPreferences, StorageClient } from "@quixi/core/contracts";
import { createPreferenceController } from "../../src/features/preferences/controller.ts";
import { isSendKey } from "../../src/features/preferences/send-key.ts";

const interaction: InteractionPreferences = {
  showTimestamps: true, showModelBadges: false, composerLayout: "compact", modelSwitcherStyle: "list",
};

test("lost save reply requires read recovery before another edit and never retries a write", async () => {
  let saved: LocalPreferences = { ...DEFAULT_LOCAL_PREFERENCES }, writes = 0;
  const controller = createPreferenceController({
    async request(_id: string, operation: string, args: { sendKey: "enter" }) {
      if (operation === "setSendKey") { writes++; saved = { ...saved, revision: 1, sendKey: args.sendKey }; throw new Error("Reply lost"); }
      return { ...saved };
    },
  } as unknown as StorageClient);
  await controller.refresh();
  await controller.setSendKey("enter");
  assert.equal(controller.getSnapshot().ready, false);
  assert.equal(controller.getSnapshot().value.sendKey, "mod-enter");
  assert.match(controller.getSnapshot().error!, /Reload preferences/);
  await controller.setSendKey("mod-enter");
  assert.equal(writes, 1);
  await controller.refresh();
  assert.equal(controller.getSnapshot().ready, true);
  assert.deepEqual(controller.getSnapshot().value, saved);
});

test("pending preference I/O admits no queued refresh or competing save", async () => {
  let calls = 0, release!: (value: LocalPreferences) => void;
  const controller = createPreferenceController({ request() { calls++; return new Promise(resolve => { release = resolve; }); } } as unknown as StorageClient);
  const pending = controller.refresh();
  await Promise.all([controller.refresh(), controller.setSendKey("enter"), controller.setInteractionPreferences(interaction), controller.refresh()]);
  assert.equal(calls, 1);
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(controller.getSnapshot().ready, false);
  release({ ...DEFAULT_LOCAL_PREFERENCES });
  await pending;
  assert.equal(controller.getSnapshot().ready, true);
});

test("invalid reads keep keyboard sending unavailable and can recover", async () => {
  let result: unknown = { version: 999, revision: 0, sendKey: "enter" };
  const controller = createPreferenceController({ async request() { return result; } } as unknown as StorageClient);
  await controller.refresh();
  assert.equal(controller.getSnapshot().ready, false);
  assert.match(controller.getSnapshot().error!, /unsupported version/);
  result = { ...DEFAULT_LOCAL_PREFERENCES, revision: 4, sendKey: "enter" };
  await controller.refresh();
  assert.equal(controller.getSnapshot().ready, true);
});

test("send keys preserve multiline input and refuse composing, repeated and modified newlines", () => {
  const enter = { key: "Enter", keyCode: 13, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false };
  assert.equal(isSendKey(enter, "enter"), true);
  assert.equal(isSendKey(enter, "mod-enter"), false);
  for (const choice of ["enter", "mod-enter"] as const) {
    assert.equal(isSendKey({ ...enter, ctrlKey: true }, choice), true);
    assert.equal(isSendKey({ ...enter, metaKey: true }, choice), true);
    for (const override of [{ shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { key: "a" }])
      assert.equal(isSendKey({ ...enter, ctrlKey: true, ...override }, choice), false);
    assert.equal(isSendKey({ ...enter, ctrlKey: true }, choice, true), false);
  }
});


test("interaction saves use the current revision, preserve the send key, and survive a later send-key change", async () => {
  let saved: LocalPreferences = { ...DEFAULT_LOCAL_PREFERENCES, revision: 7, sendKey: "enter" };
  const calls: string[] = [];
  const controller = createPreferenceController({
    async request(_id: string, operation: string, args: { expectedRevision: number; preferences: InteractionPreferences; sendKey: LocalPreferences["sendKey"] }) {
      calls.push(operation);
      if (operation !== "readLocalPreferences") {
        assert.equal(args.expectedRevision, saved.revision);
        saved = { ...saved, ...(operation === "setInteractionPreferences" ? args.preferences : { sendKey: args.sendKey }), revision: saved.revision + 1 };
      }
      return { ...saved };
    },
  } as unknown as StorageClient);
  await controller.setInteractionPreferences(interaction);
  assert.deepEqual(calls, []);
  await controller.refresh();
  await controller.setInteractionPreferences(interaction);
  assert.deepEqual(controller.getSnapshot().value, { ...DEFAULT_LOCAL_PREFERENCES, ...interaction, revision: 8, sendKey: "enter" });
  await controller.setSendKey("mod-enter");
  assert.deepEqual(controller.getSnapshot().value, { ...DEFAULT_LOCAL_PREFERENCES, ...interaction, revision: 9 });
  assert.deepEqual(calls, ["readLocalPreferences", "setInteractionPreferences", "setSendKey"]);
});

test("a lost interaction save reply blocks both edit types until read-only recovery", async () => {
  let saved: LocalPreferences = { ...DEFAULT_LOCAL_PREFERENCES, sendKey: "enter" };
  const calls: string[] = [];
  const controller = createPreferenceController({
    async request(_id: string, operation: string, args: { preferences: InteractionPreferences }) {
      calls.push(operation);
      if (operation === "setInteractionPreferences") {
        saved = { ...saved, ...args.preferences, revision: saved.revision + 1 };
        throw new Error("Reply lost after commit");
      }
      return { ...saved };
    },
  } as unknown as StorageClient);
  await controller.refresh();
  const before = controller.getSnapshot().value;
  await controller.setInteractionPreferences(interaction);
  assert.equal(controller.getSnapshot().ready, false);
  assert.equal(controller.getSnapshot().busy, false);
  assert.deepEqual(controller.getSnapshot().value, before);
  assert.match(controller.getSnapshot().error!, /Reload preferences/);
  await controller.setSendKey("mod-enter");
  await controller.setInteractionPreferences(interaction);
  assert.deepEqual(calls, ["readLocalPreferences", "setInteractionPreferences"]);
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().value, saved);
  assert.equal(controller.getSnapshot().ready, true);
  assert.equal(controller.getSnapshot().error, null);
  assert.deepEqual(calls, ["readLocalPreferences", "setInteractionPreferences", "readLocalPreferences"]);
});

test("an interaction save snapshots caller choices and admits no competing save or refresh", async () => {
  let release!: (value: LocalPreferences) => void;
  let pendingArgs: { expectedRevision: number; preferences: InteractionPreferences } | undefined;
  const calls: string[] = [];
  const controller = createPreferenceController({
    request(_id: string, operation: string, args: typeof pendingArgs) {
      calls.push(operation);
      if (operation === "readLocalPreferences") return Promise.resolve({ ...DEFAULT_LOCAL_PREFERENCES, revision: 3 });
      pendingArgs = args;
      return new Promise(resolve => { release = resolve; });
    },
  } as unknown as StorageClient);
  await controller.refresh();
  const choice = { ...interaction };
  const pending = controller.setInteractionPreferences(choice);
  choice.showTimestamps = false;
  choice.composerLayout = "comfortable";
  await Promise.all([controller.setSendKey("enter"), controller.setInteractionPreferences(choice), controller.refresh()]);
  assert.deepEqual(calls, ["readLocalPreferences", "setInteractionPreferences"]);
  assert.deepEqual(pendingArgs, { expectedRevision: 3, preferences: interaction });
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(controller.getSnapshot().value.showTimestamps, false);
  release({ ...DEFAULT_LOCAL_PREFERENCES, ...interaction, revision: 4 });
  await pending;
  assert.equal(controller.getSnapshot().ready, true);
  assert.deepEqual(controller.getSnapshot().value, { ...DEFAULT_LOCAL_PREFERENCES, ...interaction, revision: 4 });
});

test("invalid interaction receipts retain the last confirmed choices and require recovery", async () => {
  const controller = createPreferenceController({
    async request(_id: string, operation: string) {
      return operation === "readLocalPreferences" ? { ...DEFAULT_LOCAL_PREFERENCES }
        : { ...DEFAULT_LOCAL_PREFERENCES, ...interaction, revision: 1, composerLayout: "unknown" };
    },
  } as unknown as StorageClient);
  await controller.refresh();
  await controller.setInteractionPreferences(interaction);
  assert.equal(controller.getSnapshot().ready, false);
  assert.equal(controller.getSnapshot().busy, false);
  assert.deepEqual(controller.getSnapshot().value, DEFAULT_LOCAL_PREFERENCES);
  assert.match(controller.getSnapshot().error!, /Reload preferences/);
});
