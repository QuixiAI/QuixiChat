import test from "node:test";
import assert from "node:assert/strict";
import { describeStorageError } from "../../src/runtime/storage-error.ts";

const failure = (code: string, message = `worker: ${code}`) =>
  Object.assign(new Error(message), { code });

test("storage boundary codes map to actionable wording that keeps the worker detail", () => {
  const cases: Record<string, RegExp> = {
    QUOTA_EXCEEDED: /Local storage is full, so this change was not saved\..*unchanged/,
    OVERLOADED: /busy with other work\. Nothing was changed/,
    UNKNOWN_OUTCOME: /may or may not have been saved/,
    CLOSED: /closed before this change was saved/,
    CONFLICT: /changed elsewhere first/,
    IO_ERROR: /read or write failed, so this change was not saved/,
    MIGRATION_FAILED: /schema does not match this version/,
  };
  for (const [code, expected] of Object.entries(cases)) {
    const text = describeStorageError(failure(code));
    assert.match(text, expected, code);
    assert.ok(text.endsWith(`(worker: ${code})`), code);
    assert.doesNotMatch(text, /automatically recovered|retried for you/i, code);
  }
});

test("unknown codes and plain values fall back to the original message", () => {
  assert.equal(describeStorageError(failure("INTERNAL", "plain detail")), "plain detail");
  assert.equal(describeStorageError(new Error("no code")), "no code");
  assert.equal(describeStorageError("string failure"), "string failure");
  assert.equal(describeStorageError({ message: "object message" }), "object message");
});
