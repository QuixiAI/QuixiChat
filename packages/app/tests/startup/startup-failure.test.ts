import test from "node:test";
import assert from "node:assert/strict";
import { describeStartupFailure } from "../../src/runtime/startup-failure.ts";

const failure = (code: string, message = `worker said ${code}`) =>
  Object.assign(new Error(message), { code });

test("known storage boundary codes map to bounded guidance that keeps the worker message", () => {
  const cases: Record<string, { title: RegExp; retryable: boolean; guidance: RegExp }> = {
    MIGRATION_FAILED: { title: /different version of Quixi/, retryable: false, guidance: /not available yet/ },
    CONFLICT: { title: /Another Quixi window/, retryable: true, guidance: /Close other Quixi tabs/ },
    UNSUPPORTED: { title: /unavailable in this session/, retryable: false, guidance: /regular browser profile/ },
    QUOTA_EXCEEDED: { title: /storage is full/, retryable: true, guidance: /Free site storage/ },
    IO_ERROR: { title: /could not be read/, retryable: true, guidance: /free disk space/ },
    NOT_FOUND: { title: /archive is missing/, retryable: false, guidance: /does not create an empty archive/ },
    OVERLOADED: { title: /could not finish opening/, retryable: true, guidance: /Try again/ },
    CLOSED: { title: /could not finish opening/, retryable: true, guidance: /Try again/ },
    INTERNAL: { title: /could not open your archive/, retryable: true, guidance: /keep the details below/ },
  };
  for (const [code, expected] of Object.entries(cases)) {
    const described = describeStartupFailure(failure(code));
    assert.equal(described.code, code);
    assert.equal(described.message, `worker said ${code}`);
    assert.match(described.title, expected.title, code);
    assert.match(described.guidance, expected.guidance, code);
    assert.equal(described.retryable, expected.retryable, code);
    assert.doesNotMatch(described.guidance, /export .* is available|recovered automatically/i, code);
  }
});

test("unknown codes, plain errors and non-errors fall back without inventing a code", () => {
  for (const input of [failure("SOMETHING_ELSE"), new Error("plain failure"), "string failure", null, { code: 42 }]) {
    const described = describeStartupFailure(input);
    assert.equal(described.code, "UNKNOWN");
    assert.match(described.title, /could not open your archive/);
    assert.equal(described.retryable, true);
    assert.ok(described.message.length > 0);
  }
  assert.equal(describeStartupFailure(new Error("plain failure")).message, "plain failure");
  assert.equal(describeStartupFailure("string failure").message, "string failure");
  assert.equal(describeStartupFailure(failure("IO_ERROR", "x".repeat(5000))).message.length, 4096);
});
