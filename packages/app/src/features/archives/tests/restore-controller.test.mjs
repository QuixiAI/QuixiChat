import { test } from "node:test";
import assert from "node:assert/strict";
import { createRestoreController } from "../restore-controller.ts";
const id = () => crypto.randomUUID();
const unknown = () =>
  Object.assign(new Error("Reply lost"), { code: "UNKNOWN_OUTCOME" });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  const calls = [],
    hostCalls = [],
    statusCalls = [];
  const selection = { archiveId: "original", selectionRevision: 3 };
  let context = { selection: { ...selection }, expectedRevision: 7 },
    reason = null,
    activationError = null,
    globalStatus = { status: "not_found" },
    onActivate = null,
    readGate = null;
  const candidate = {
    archiveId: id(),
    schemaVersion: 9,
    canonicalRecords: 23,
    syncOperations: 12,
    blobCount: 2,
    blobBytes: 75000000,
    streamingGenerations: 1,
    defaultWorkspaceId: id(),
    manifestSha256: "a".repeat(64),
  };
  let job = {
    jobId: id(),
    kind: "restore",
    format: "portable",
    state: "ready",
    phase: "ready",
    completedBytes: 3,
    totalBytes: 3,
    completedRecords: 23,
    totalRecords: 23,
    entryCount: 5,
    failure: null,
    output: null,
    candidate,
  };
  const host = {
    async chooseFiles(request, args) {
      hostCalls.push(["chooseFiles", request, args]);
      return [
        {
          id: id(),
          name: "synthetic.tar",
          mediaType: "application/x-tar",
          byteLength: 3,
        },
      ];
    },
    async openFileTransfer() {
      hostCalls.push(["open"]);
      return { transferId: "host-input", maxChunkBytes: 65536, maxInFlight: 4 };
    },
    async readChunk() {
      hostCalls.push(["read"]);
      if (readGate) await readGate.promise;
      return {
        transferId: "host-input",
        sequence: 0,
        offset: 0,
        bytes: new Uint8Array([1, 2, 3]),
        final: true,
      };
    },
    async acknowledgeChunk(args) {
      hostCalls.push(["ack", args]);
    },
    async releaseTransfer() {
      hostCalls.push(["releaseTransfer"]);
    },
    async releaseFile() {
      hostCalls.push(["releaseFile"]);
    },
    async cancel() {
      hostCalls.push(["cancel"]);
    },
  };
  const receipt = (args) => ({
    operationId: args.operationId,
    payloadSha256: "b".repeat(64),
    previous: { ...args.expectedSelection },
    selected: {
      archiveId: args.review.candidate.archiveId,
      selectionRevision: args.expectedSelection.selectionRevision + 1,
    },
    review: structuredClone(args.review),
  });
  const storage = {
    async request(request, op, args) {
      calls.push({ op, args: structuredClone(args) });
      switch (op) {
        case "beginArchiveRestore":
          job = {
            ...job,
            jobId: args.operationId,
            state: "working",
            phase: "receiving",
            candidate: null,
          };
          return {
            job: structuredClone(job),
            inputTransfer: {
              transferId: "storage-input",
              maxChunkBytes: 2,
              maxInFlight: 4,
            },
          };
        case "finishArchiveRestore":
          job = { ...job, phase: "schema_validation" };
          return structuredClone(job);
        case "advanceArchiveJob":
          job = { ...job, state: "ready", phase: "ready", candidate };
          return structuredClone(job);
        case "archiveJobStatus":
          return structuredClone(job);
        case "releaseArchiveJob":
          return { ...job, state: "released" };
        case "readArchiveActivationContext":
          return structuredClone(context);
        case "prepareArchiveActivation":
          return {
            token: id(),
            jobId: args.jobId,
            candidate: { ...candidate },
            expectedActiveArchiveId: args.expectedActiveArchiveId,
            expectedRevision: args.expectedRevision,
          };
        case "activateRestoredArchive":
          onActivate?.(args);
          if (activationError) throw activationError;
          return receipt(args);
        default:
          throw new Error(`Unexpected ${op}`);
      }
    },
    async sendChunk(chunk) {
      calls.push({
        op: "sendChunk",
        args: { ...chunk, bytes: [...chunk.bytes] },
      });
      return {
        transferId: chunk.transferId,
        sequence: chunk.sequence,
        committedOffset: chunk.offset + chunk.bytes.length,
      };
    },
    async cancel() {
      calls.push({ op: "cancel" });
    },
  };
  const options = {
    storage,
    host,
    selection,
    canReplace: () => reason,
    async activationStatus(operationId, args) {
      statusCalls.push({ operationId, args: structuredClone(args) });
      if (globalStatus instanceof Error) throw globalStatus;
      return structuredClone(globalStatus);
    },
  };
  const controller = createRestoreController(options);
  return {
    controller,
    options,
    calls,
    hostCalls,
    statusCalls,
    candidate,
    receipt,
    get job() {
      return job;
    },
    get context() {
      return context;
    },
    set reason(value) {
      reason = value;
    },
    set activationError(value) {
      activationError = value;
    },
    set globalStatus(value) {
      globalStatus = value;
    },
    set onActivate(value) {
      onActivate = value;
    },
    set readGate(value) {
      readGate = value;
    },
  };
}
const activations = (f) =>
  f.calls.filter((c) => c.op === "activateRestoredArchive");
async function reviewed(f) {
  await f.controller.resume(f.job.jobId);
  await f.controller.prepareReview();
  assert.ok(
    f.controller.getSnapshot().review,
    f.controller.getSnapshot().error,
  );
}
test("selected file runs genuine bounded staging, releases handles and never implicitly activates", async () => {
  const f = fixture();
  await f.controller.choose();
  assert.equal(f.controller.getSnapshot().job.state, "ready");
  assert.deepEqual(
    f.calls.filter((c) => c.op === "sendChunk").map((c) => c.args.bytes),
    [[1, 2], [3]],
  );
  assert.equal(
    f.calls.find((c) => c.op === "finishArchiveRestore").args.sha256,
    "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  );
  assert.equal(f.hostCalls.filter((c) => c[0] === "ack").length, 1);
  assert.equal(f.hostCalls.filter((c) => c[0] === "releaseFile").length, 1);
  assert.equal(f.hostCalls.filter((c) => c[0] === "releaseTransfer").length, 1);
  assert.equal(activations(f).length, 0);
  await f.controller.prepareReview();
  assert.equal(activations(f).length, 0);
  assert.equal(f.controller.getSnapshot().committedReceipt, null);
  await f.controller.dispose();
  assert.equal(f.calls.filter((c) => c.op === "releaseArchiveJob").length, 1);
});
test("review is explicit, receipt and args retained before dispatch, open is outside controller", async () => {
  const f = fixture();
  await reviewed(f);
  let retained;
  f.onActivate = (args) => {
    retained = f.controller.getSnapshot().activationArgs;
    assert.deepEqual(retained, args);
    assert.ok(Object.isFrozen(retained.review.candidate));
  };
  await f.controller.activate();
  assert.equal(activations(f).length, 1);
  assert.equal(
    f.controller.getSnapshot().committedReceipt.operationId,
    retained.operationId,
  );
  assert.equal(f.controller.getSnapshot().busy, null);
  assert.match(
    f.controller.getSnapshot().notice,
    /previous archive is retained/,
  );
  await f.controller.activate();
  assert.equal(activations(f).length, 1);
  await f.controller.dispose();
  assert.equal(f.calls.filter((c) => c.op === "releaseArchiveJob").length, 0);
});
test("new history invalidates review and requires a new explicit review", async () => {
  const f = fixture();
  await reviewed(f);
  f.context.expectedRevision++;
  await f.controller.activate();
  assert.equal(activations(f).length, 0);
  assert.equal(f.controller.getSnapshot().review, null);
  assert.match(f.controller.getSnapshot().error, /changed/);
  await f.controller.prepareReview();
  assert.equal(f.controller.getSnapshot().review.expectedRevision, 8);
  assert.equal(activations(f).length, 0);
  await f.controller.dispose();
});
test("selection remains fixed even if caller mutates options or live selection changes", async () => {
  const f = fixture();
  f.options.selection.archiveId = "caller-mutated";
  await reviewed(f);
  assert.equal(
    f.controller.getSnapshot().review.expectedActiveArchiveId,
    "original",
  );
  f.context.selection.selectionRevision++;
  await f.controller.activate();
  assert.equal(activations(f).length, 0);
  await f.controller.prepareReview();
  assert.equal(f.controller.getSnapshot().review, null);
  await f.controller.dispose();
});
test("unsent draft or live work prevents both review and activation", async () => {
  const f = fixture();
  await f.controller.resume(f.job.jobId);
  f.reason = "Save or discard your unsent draft first.";
  await f.controller.prepareReview();
  assert.match(f.controller.getSnapshot().error, /unsent draft/);
  assert.equal(
    f.calls.filter((c) => c.op === "prepareArchiveActivation").length,
    0,
  );
  f.reason = null;
  await f.controller.prepareReview();
  f.reason = "A generation is still running.";
  await f.controller.activate();
  assert.match(f.controller.getSnapshot().error, /still running/);
  assert.equal(activations(f).length, 0);
  await f.controller.dispose();
});
test("lost reply resolves committed receipt through global status using exact retained identity", async () => {
  const f = fixture();
  await reviewed(f);
  f.activationError = unknown();
  f.onActivate = (args) => {
    f.globalStatus = {
      status: "committed",
      payloadSha256: "b".repeat(64),
      receipt: f.receipt(args),
    };
  };
  await f.controller.activate();
  assert.equal(
    f.controller.getSnapshot().committedReceipt.selected.archiveId,
    f.candidate.archiveId,
  );
  assert.deepEqual(f.statusCalls[0].args, activations(f)[0].args);
  assert.equal(activations(f).length, 1);
  await f.controller.dispose();
});
test("unresolved and unavailable global status retain full args; checking never replays activation", async () => {
  const f = fixture();
  await reviewed(f);
  f.activationError = unknown();
  await f.controller.activate();
  const args = f.controller.getSnapshot().activationArgs;
  assert.match(f.controller.getSnapshot().notice, /unresolved/);
  assert.equal(f.controller.getSnapshot().committedReceipt, null);
  f.globalStatus = new Error("Profile owner unavailable");
  await f.controller.checkActivation();
  assert.match(f.controller.getSnapshot().error, /unavailable/);
  await f.controller.choose();
  await f.controller.release();
  await f.controller.prepareReview();
  assert.equal(activations(f).length, 1);
  assert.equal(f.hostCalls.length, 0);
  assert.deepEqual(f.controller.getSnapshot().activationArgs, args);
  f.globalStatus = {
    status: "committed",
    payloadSha256: "b".repeat(64),
    receipt: f.receipt(args),
  };
  await f.controller.checkActivation();
  assert.ok(f.controller.getSnapshot().committedReceipt);
  assert.ok(
    f.statusCalls.every((call) => call.operationId === args.operationId),
  );
  await f.controller.dispose();
});
test("a mismatched receipt is never exposed as a committed replacement", async () => {
  const f = fixture();
  await reviewed(f);
  f.activationError = unknown();
  f.onActivate = (args) => {
    f.globalStatus = {
      status: "committed",
      payloadSha256: "b".repeat(64),
      receipt: { ...f.receipt(args), operationId: id() },
    };
  };
  await f.controller.activate();
  assert.equal(f.controller.getSnapshot().committedReceipt, null);
  assert.match(f.controller.getSnapshot().error, /does not match/);
  await f.controller.dispose();
});
test("cancelling an in-flight source read releases staging with no activation", async () => {
  const f = fixture(),
    gate = deferred();
  f.readGate = gate;
  const running = f.controller.choose();
  while (!f.hostCalls.some((call) => call[0] === "read"))
    await new Promise((resolve) => setTimeout(resolve, 0));
  f.controller.cancel();
  gate.resolve();
  await running;
  assert.match(f.controller.getSnapshot().error, /cancelled/i);
  assert.equal(activations(f).length, 0);
  assert.ok(f.calls.some((call) => call.op === "releaseArchiveJob"));
  assert.ok(f.hostCalls.some((call) => call[0] === "releaseFile"));
  await f.controller.dispose();
});
test("same release identity resolves an unknown cleanup reply with one bounded retry", async () => {
  const f = fixture();
  await f.controller.resume(f.job.jobId);
  const original = f.options.storage.request;
  let first = true;
  f.options.storage.request = async (...args) => {
    const result = await original(...args);
    if (args[1] === "releaseArchiveJob" && first) {
      first = false;
      throw unknown();
    }
    return result;
  };
  await f.controller.release();
  const releases = f.calls.filter((c) => c.op === "releaseArchiveJob");
  assert.equal(releases.length, 2);
  assert.deepEqual(releases[0].args, releases[1].args);
  assert.equal(f.controller.getSnapshot().job, null);
  await f.controller.dispose();
});
test("live work appearing during activation context lookup still prevents dispatch", async () => {
  const f = fixture();
  await reviewed(f);
  const original = f.options.storage.request,
    gate = deferred();
  let entered = false;
  f.options.storage.request = async (...args) => {
    const result = await original(...args);
    if (args[1] === "readArchiveActivationContext") {
      entered = true;
      await gate.promise;
    }
    return result;
  };
  const activating = f.controller.activate();
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  f.reason = "A new unsent draft needs your attention.";
  gate.resolve();
  await activating;
  assert.equal(activations(f).length, 0);
  assert.match(f.controller.getSnapshot().error, /unsent draft/);
  await f.controller.dispose();
});
test("cancelling the picker releases a subsequently returned file before any restore begins", async () => {
  const f = fixture(),
    gate = deferred();
  f.options.host.chooseFiles = async () => {
    await gate.promise;
    return [
      {
        id: id(),
        name: "synthetic.tar",
        mediaType: "application/x-tar",
        byteLength: 3,
      },
    ];
  };
  const choosing = f.controller.choose();
  f.controller.cancel();
  gate.resolve();
  await choosing;
  assert.equal(
    f.calls.filter((call) => call.op === "beginArchiveRestore").length,
    0,
  );
  assert.ok(f.hostCalls.some((call) => call[0] === "releaseFile"));
  assert.equal(activations(f).length, 0);
  await f.controller.dispose();
});
test("concurrent replacement actions send one request and never invoke a remount callback", async () => {
  const f = fixture();
  await reviewed(f);
  const original = f.options.storage.request,
    gate = deferred();
  let entered = false;
  f.options.storage.request = async (...args) => {
    if (args[1] === "activateRestoredArchive") {
      entered = true;
      await gate.promise;
    }
    return original(...args);
  };
  const first = f.controller.activate();
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  await f.controller.activate();
  gate.resolve();
  await first;
  assert.equal(activations(f).length, 1);
  assert.ok(f.controller.getSnapshot().committedReceipt);
  assert.equal(f.controller.getSnapshot().busy, null);
  await f.controller.dispose();
});
test("saved ready candidate revalidates in bounded slices before fresh explicit review", async () => {
  const f = fixture(),
    original = f.options.storage.request;
  let advances = 0;
  f.options.storage.request = async (...args) => {
    if (args[1] === "advanceArchiveJob") {
      advances++;
      assert.equal(args[2].maxRecords, 64);
      assert.equal(args[2].maxBytes, 262144);
      const result = await original(...args);
      return advances === 1
        ? { ...result, state: "working", phase: "blob_validation" }
        : result;
    }
    return original(...args);
  };
  await f.controller.resume(f.job.jobId);
  assert.equal(advances, 2);
  assert.equal(f.controller.getSnapshot().job.state, "ready");
  assert.equal(f.controller.getSnapshot().review, null);
  assert.equal(activations(f).length, 0);
  await f.controller.prepareReview();
  assert.ok(f.controller.getSnapshot().review);
  assert.equal(activations(f).length, 0);
  await f.controller.dispose();
});
test("cancelling saved-candidate revalidation cancels pending slice and releases work without activation", async () => {
  const f = fixture(),
    original = f.options.storage.request,
    gate = deferred();
  let entered = false;
  f.options.storage.request = async (...args) => {
    const result = await original(...args);
    if (args[1] === "advanceArchiveJob") {
      entered = true;
      await gate.promise;
    }
    return result;
  };
  const resuming = f.controller.resume(f.job.jobId);
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 0));
  f.controller.cancel();
  gate.resolve();
  await resuming;
  assert.ok(f.calls.some((call) => call.op === "cancel"));
  assert.ok(f.calls.some((call) => call.op === "releaseArchiveJob"));
  assert.equal(f.controller.getSnapshot().job, null);
  assert.match(f.controller.getSnapshot().error, /cancelled/i);
  assert.equal(activations(f).length, 0);
  await f.controller.dispose();
});
test("changed saved candidate cannot silently replace the originally resumed review", async () => {
  const f = fixture(),
    original = f.options.storage.request;
  f.options.storage.request = async (...args) => {
    const result = await original(...args);
    return args[1] === "advanceArchiveJob"
      ? {
          ...result,
          candidate: {
            ...result.candidate,
            blobBytes: result.candidate.blobBytes + 1,
          },
        }
      : result;
  };
  await f.controller.resume(f.job.jobId);
  assert.equal(f.controller.getSnapshot().review, null);
  assert.equal(f.controller.getSnapshot().job, null);
  assert.match(f.controller.getSnapshot().error, /changed during revalidation/);
  assert.equal(activations(f).length, 0);
  await f.controller.dispose();
});
