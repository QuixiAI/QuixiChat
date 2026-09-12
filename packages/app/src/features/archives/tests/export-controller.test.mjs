import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportController } from "../controller.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const emptyJobs = { items: [], nextJobId: null };
function fixture(listJobs, listDownloads = async () => []) {
  const calls = [];
  const controller = createExportController({
    storage: {
      async request(_id, operation) {
        calls.push(operation);
        if (operation === "listArchiveJobs") return listJobs();
        if (operation === "beginArchiveExport") throw new Error("Synthetic preparation boundary reached");
        if (operation === "releaseArchiveJob") return;
        throw new Error(`Unexpected operation: ${operation}`);
      },
    },
    host: {},
    temporaryDownloads: { list: listDownloads },
  });
  return { controller, calls };
}

test("initialization stays busy through both reads, rejects competing work, and permits an explicit later prepare", async () => {
  const jobs = deferred(), downloads = deferred();
  const { controller, calls } = fixture(() => jobs.promise, () => downloads.promise);
  const initialization = controller.initialize();
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(controller.getSnapshot().cancellable, false);
  await controller.prepare("portable");
  await controller.refreshJobs();
  assert.deepEqual(calls, ["listArchiveJobs"]);
  jobs.resolve(emptyJobs);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getSnapshot().busy, true);
  downloads.resolve([]);
  await initialization;
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().cancellable, false);
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(calls.includes("beginArchiveExport"), false, "rejected preparation is never replayed");
  await controller.prepare("portable");
  assert.equal(calls.filter(value => value === "beginArchiveExport").length, 1);
  assert.match(controller.getSnapshot().error, /Synthetic preparation boundary reached/);
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().cancellable, false);
  await controller.dispose();
});

test("failed initialization returns idle with an error and an explicit refresh recovers", async () => {
  const jobs = deferred();
  let first = true;
  const { controller, calls } = fixture(() => first ? jobs.promise : emptyJobs);
  const initialization = controller.initialize();
  assert.equal(controller.getSnapshot().busy, true);
  jobs.reject(new Error("Archive listing unavailable"));
  await initialization;
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().error, "Archive listing unavailable");
  assert.deepEqual(calls, ["listArchiveJobs"]);
  first = false;
  await controller.initialize();
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().error, null);
  await controller.prepare("open");
  assert.equal(calls.filter(value => value === "beginArchiveExport").length, 1);
  await controller.dispose();
});

test("idle publication admits the next action and busy publication cannot reenter initialization", async () => {
  const jobs = deferred();
  const { controller, calls } = fixture(() => jobs.promise);
  let attempted = false, following;
  const unsubscribe = controller.subscribe(() => {
    if (controller.getSnapshot().busy && !attempted) {
      attempted = true;
      void controller.initialize();
    } else if (!controller.getSnapshot().busy && !following) {
      following = Promise.resolve();
      following = controller.prepare("portable");
    }
  });
  const initialization = controller.initialize();
  jobs.resolve(emptyJobs);
  await initialization;
  await following;
  unsubscribe();
  assert.equal(calls.filter(value => value === "listArchiveJobs").length, 1);
  assert.equal(calls.filter(value => value === "beginArchiveExport").length, 1);
  assert.equal(controller.getSnapshot().busy, false);
  await controller.dispose();
});

for (const operation of ["prepare", "resume"]) test(`${operation} advertises cancellation only during preparation and clears it after cancellation cleanup`, async () => {
  const gate = deferred(), started = deferred(), cancellations = [], calls = [];
  const controller = createExportController({
    storage: {
      async request(requestId, name, args) {
        calls.push(name);
        if (name === "beginArchiveExport" || name === "archiveJobStatus") {
          started.resolve({ requestId, operationId: args.operationId ?? null });
          return gate.promise;
        }
        if (name === "releaseArchiveJob") return;
        throw new Error(`Unexpected operation: ${name}`);
      },
      async cancel(requestId, operationId) { cancellations.push({ requestId, operationId }); },
    },
    host: {},
  });
  assert.equal(controller.getSnapshot().cancellable, false);
  const pending = operation === "prepare" ? controller.prepare("portable") : controller.resume("synthetic-job");
  const request = await started.promise;
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(controller.getSnapshot().cancellable, true);
  controller.cancel();
  assert.deepEqual(cancellations, [request]);
  assert.equal(controller.getSnapshot().cancellable, false);
  assert.equal(controller.getSnapshot().busy, true, "cancelled work remains busy until cleanup settles");
  gate.resolve({ jobId: "synthetic-job", kind: "export", state: "ready" });
  await pending;
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(controller.getSnapshot().cancellable, false);
  assert.match(controller.getSnapshot().error, /cancelled/);
  assert.deepEqual(calls, [operation === "prepare" ? "beginArchiveExport" : "archiveJobStatus", "releaseArchiveJob"]);
  await controller.dispose();
});


test("prepare followed by immediate dispose dispatches no storage request", async () => {
  const { controller, calls } = fixture(async () => emptyJobs);
  const prepare = controller.prepare("portable");
  const dispose = controller.dispose();
  await Promise.all([prepare, dispose]);
  assert.deepEqual(calls, []);
});

test("dispose from the busy subscriber dispatches no storage request", async () => {
  const { controller, calls } = fixture(async () => emptyJobs);
  let dispose;
  controller.subscribe(() => {
    if (controller.getSnapshot().busy && !dispose) dispose = controller.dispose();
  });
  const prepare = controller.prepare("portable");
  assert.ok(dispose, "subscriber disposes during synchronous busy publication");
  await Promise.all([prepare, dispose]);
  assert.deepEqual(calls, []);
});
