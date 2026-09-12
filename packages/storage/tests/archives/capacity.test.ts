import test from "node:test";
import assert from "node:assert/strict";
import { ARCHIVE_CAPACITY_SLACK_BYTES, archiveCapacityDecision, archiveCapacityRequirement } from "../../src/worker/archives/capacity.ts";

test("an export needs the database and every blob plus slack; a restore needs the container twice", () => {
  const exported = archiveCapacityRequirement({ kind: "export", databaseBytes: 100 * 1024 ** 2, blobBytes: 40 * 1024 ** 2 });
  assert.equal(exported.requiredBytes, 140 * 1024 ** 2 + ARCHIVE_CAPACITY_SLACK_BYTES);
  assert.match(exported.basis, /database 100\.0 MB \+ blobs 40\.0 MB/);
  const restored = archiveCapacityRequirement({ kind: "restore", expectedBytes: 106 * 1024 ** 2 });
  assert.equal(restored.requiredBytes, 212 * 1024 ** 2 + ARCHIVE_CAPACITY_SLACK_BYTES);
});

test("the decision refuses with the numbers only when the browser reports less free space than required", () => {
  const requirement = archiveCapacityRequirement({ kind: "export", databaseBytes: 100 * 1024 ** 2, blobBytes: 0 });
  const refused = archiveCapacityDecision(requirement, { usage: 950 * 1024 ** 2, quota: 1000 * 1024 ** 2 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.availableBytes, 50 * 1024 ** 2);
  assert.match(refused.reason ?? "", /needs about 108\.0 MB of free local storage .* reports about 50\.0 MB free/);
  const allowed = archiveCapacityDecision(requirement, { usage: 100 * 1024 ** 2, quota: 1000 * 1024 ** 2 });
  assert.deepEqual({ allowed: allowed.allowed, reason: allowed.reason }, { allowed: true, reason: null });
  // Unknown or malformed estimates never refuse: the browser's own quota error still stops the job safely.
  for (const estimate of [null, { usage: null, quota: null }, { usage: 10, quota: 0 }, { usage: Number.NaN, quota: 5 }])
    assert.equal(archiveCapacityDecision(requirement, estimate as never).allowed, true, JSON.stringify(estimate));
});
