import type {
  ArchiveActivationArgs,
  ArchiveActivationReceipt,
  ArchiveActivationReview,
  ArchiveActivationStatus,
  ArchiveJobStatus,
  ArchiveSelection,
  HostClient,
  StorageClient,
} from "@quixi/core/contracts";
import { sameArchiveSelection } from "@quixi/core/contracts";
import { stageArchiveRestore } from "./index.ts";

export interface RestoreControllerOptions {
  storage: StorageClient;
  host: HostClient;
  /** Selection captured when this app session opened. Never silently refreshed. */
  selection: ArchiveSelection;
  activationStatus(
    operationId: string,
    args?: ArchiveActivationArgs,
  ): Promise<ArchiveActivationStatus>;
  canReplace(): string | null;
}
export interface RestoreSnapshot {
  busy:
    | "choosing"
    | "staging"
    | "reviewing"
    | "activating"
    | "checking"
    | "releasing"
    | null;
  job: ArchiveJobStatus | null;
  sourceName: string | null;
  review: ArchiveActivationReview | null;
  activationArgs: ArchiveActivationArgs | null;
  activationStatus: ArchiveActivationStatus | null;
  committedReceipt: ArchiveActivationReceipt | null;
  error: string | null;
  notice: string | null;
}
const id = () => crypto.randomUUID();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const copy = <T>(value: T): T => freeze(structuredClone(value));
const sameCandidate = (
  a: ArchiveActivationReview["candidate"],
  b: ArchiveActivationReview["candidate"],
) => (Object.keys(a) as (keyof typeof a)[]).every((key) => a[key] === b[key]);
const sameReview = (a: ArchiveActivationReview, b: ArchiveActivationReview) =>
  a.token === b.token &&
  a.jobId === b.jobId &&
  a.expectedActiveArchiveId === b.expectedActiveArchiveId &&
  a.expectedRevision === b.expectedRevision &&
  sameCandidate(a.candidate, b.candidate);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const code = (error: unknown) => (error as { code?: string })?.code;

/** A review is bound to this controller's initial selection and a particular
 * source revision. Activation is never retried here, even after a lost reply.
 * The caller opens/remounts a committed selection outside this controller. */
export function createRestoreController(options: RestoreControllerOptions) {
  const { storage, host, activationStatus, canReplace } = options;
  const selection = copy(options.selection),
    listeners = new Set<() => void>();
  let state: RestoreSnapshot = freeze({
    busy: null,
    job: null,
    sourceName: null,
    review: null,
    activationArgs: null,
    activationStatus: null,
    committedReceipt: null,
    error: null,
    notice: null,
  });
  let active: Promise<void> | null = null,
    disposed = false;
  let abort: AbortController | null = null,
    chooserId: string | null = null;
  let releaseIdentity: { jobId: string; operationId: string } | null = null;
  function patch(value: Partial<RestoreSnapshot>) {
    if (disposed) return;
    state = freeze({ ...state, ...value });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* observer only */
      }
    }
  }
  function stopped() {
    if (disposed || abort?.signal.aborted)
      throw new Error("Restore preparation cancelled.");
  }
  function replacementAllowed() {
    const reason = canReplace();
    if (reason) throw new Error(reason);
  }
  async function work(
    phase: NonNullable<RestoreSnapshot["busy"]>,
    action: () => Promise<void>,
  ) {
    if (disposed || active) return;
    let done!: () => void;
    const task = new Promise<void>((resolve) => {
      done = resolve;
    });
    active = task;
    patch({ busy: phase, error: null, notice: null });
    try {
      await action();
    } catch (error) {
      patch({ error: message(error) });
    } finally {
      abort = null;
      chooserId = null;
      active = null;
      patch({ busy: null });
      done();
    }
  }
  function idleCandidateAllowed() {
    if (state.activationArgs)
      throw new Error(
        "An activation was dispatched. Check its outcome before leaving this review.",
      );
  }
  async function releaseJob(jobId: string) {
    if (releaseIdentity?.jobId !== jobId)
      releaseIdentity = { jobId, operationId: id() };
    const args = releaseIdentity;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await storage.request(id(), "releaseArchiveJob", args);
        return;
      } catch (error) {
        if (attempt || code(error) !== "UNKNOWN_OUTCOME") throw error;
      }
    }
  }
  async function dropCandidate() {
    if (state.job) await releaseJob(state.job.jobId);
    patch({ job: null, review: null, sourceName: null });
  }
  function ready(job: ArchiveJobStatus) {
    if (
      job.kind !== "restore" ||
      job.format !== "portable" ||
      job.state !== "ready" ||
      !job.candidate
    )
      throw new Error(
        "This saved job is not a validated portable restore candidate.",
      );
    patch({
      job: copy(job),
      review: null,
      notice: "Candidate validated. The current archive is still selected.",
    });
  }
  async function contextMatches(review?: ArchiveActivationReview) {
    const context = await storage.request(
      id(),
      "readArchiveActivationContext",
      null,
    );
    stopped();
    if (
      !sameArchiveSelection(context.selection, selection) ||
      (review && context.expectedRevision !== review.expectedRevision)
    ) {
      patch({ review: null });
      throw new Error(
        "The active archive or its history changed. Review again in the current archive session before replacing it.",
      );
    }
    return context;
  }
  function acceptReceipt(
    receipt: ArchiveActivationReceipt,
    args: ArchiveActivationArgs,
  ) {
    if (
      receipt.operationId !== args.operationId ||
      !sameArchiveSelection(receipt.previous, args.expectedSelection) ||
      receipt.selected.archiveId !== args.review.candidate.archiveId ||
      receipt.selected.selectionRevision !==
        args.expectedSelection.selectionRevision + 1 ||
      !sameReview(receipt.review, args.review)
    )
      throw new Error(
        "Activation receipt does not match the retained review. Keep this session open and check the activation outcome.",
      );
    patch({
      committedReceipt: copy(receipt),
      notice:
        "Restored archive selected. The previous archive is retained. Open the restored archive when ready.",
      error: null,
    });
  }
  async function resolveActivation(args: ArchiveActivationArgs) {
    const status = await activationStatus(args.operationId, args);
    patch({ activationStatus: copy(status) });
    if (status.status === "committed") acceptReceipt(status.receipt, args);
    else
      patch({
        notice:
          status.status === "failed"
            ? `Activation failed: ${status.reason ?? "No replacement was committed."}`
            : "Activation outcome is unresolved. Keep this review and check again; no new activation will be sent.",
      });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async choose() {
      return work("choosing", async () => {
        idleCandidateAllowed();
        abort = new AbortController();
        chooserId = id();
        // The picker is the first awaited host call, preserving the button gesture.
        const files = await host.chooseFiles(chooserId, {
          multiple: false,
          mediaTypes: ["application/x-tar"],
        });
        chooserId = null;
        const file = files[0];
        for (const extra of files.slice(1))
          await host.releaseFile(id(), extra.id).catch(() => {});
        if (!file) return;
        let consumed = false;
        try {
          stopped();
          await dropCandidate();
          stopped();
          patch({ busy: "staging", sourceName: file.name.slice(0, 512) });
          consumed = true;
          const job = await stageArchiveRestore(storage, host, file, {
            signal: abort.signal,
            onProgress: (job) => patch({ job: copy(job) }),
          });
          if (disposed || abort.signal.aborted) {
            await releaseJob(job.jobId);
            stopped();
          }
          ready(job);
        } finally {
          if (!consumed) await host.releaseFile(id(), file.id).catch(() => {});
        }
      });
    },
    async resume(jobId: string) {
      return work("staging", async () => {
        idleCandidateAllowed();
        abort = new AbortController();
        const job = await storage.request(id(), "archiveJobStatus", { jobId });
        stopped();
        if (job.kind !== "restore" || job.state !== "ready" || !job.candidate)
          throw new Error("Only a ready restore candidate can be resumed.");
        if (state.job?.jobId !== jobId) await dropCandidate();
        patch({ job: copy(job), review: null });
        try {
          // A persisted ready record does not prove that this owner validated
          // its candidate. Advance once even when ready, then await bounded
          // verification slices before allowing a fresh replacement review.
          let validated = job;
          do {
            stopped();
            const requestId = id(),
              operationId = id(),
              signal = abort.signal;
            const cancel = () => {
              void storage.cancel(requestId, operationId).catch(() => {});
            };
            signal.addEventListener("abort", cancel, { once: true });
            try {
              validated = await storage.request(
                requestId,
                "advanceArchiveJob",
                {
                  operationId,
                  jobId,
                  maxRecords: 64,
                  maxBytes: 262144,
                },
              );
            } finally {
              signal.removeEventListener("abort", cancel);
            }
            stopped();
            patch({ job: copy(validated) });
            await new Promise((resolve) => setTimeout(resolve, 0));
          } while (validated.state === "working");
          stopped();
          if (validated.state !== "ready" || !validated.candidate)
            throw new Error(
              validated.failure?.reason ??
                "Saved candidate could not be revalidated.",
            );
          if (!sameCandidate(validated.candidate, job.candidate))
            throw new Error(
              "Saved candidate changed during revalidation. Choose and validate the source archive again.",
            );
          ready(validated);
        } catch (error) {
          // Releasing work never deletes a validated candidate namespace.
          await releaseJob(jobId).catch(() => {});
          patch({ job: null, review: null });
          throw error;
        }
      });
    },
    async prepareReview() {
      return work("reviewing", async () => {
        idleCandidateAllowed();
        patch({ review: null });
        replacementAllowed();
        const job = state.job;
        if (!job?.candidate || job.state !== "ready")
          throw new Error("Choose and validate a portable archive first.");
        const context = await contextMatches();
        const review = await storage.request(id(), "prepareArchiveActivation", {
          operationId: id(),
          jobId: job.jobId,
          expectedActiveArchiveId: selection.archiveId,
          expectedRevision: context.expectedRevision,
        });
        await contextMatches(review);
        replacementAllowed();
        if (
          review.jobId !== job.jobId ||
          review.expectedActiveArchiveId !== selection.archiveId ||
          !sameCandidate(review.candidate, job.candidate)
        )
          throw new Error(
            "Candidate review changed. Validate and review the candidate again.",
          );
        patch({
          review: copy(review),
          notice:
            "Review the candidate below. Replacement requires the separate confirmation button.",
        });
      });
    },
    async activate() {
      return work("activating", async () => {
        idleCandidateAllowed();
        replacementAllowed();
        const review = state.review;
        if (!review)
          throw new Error(
            "Review this candidate before replacing the active archive.",
          );
        await contextMatches(review);
        replacementAllowed();
        stopped();
        // Persist in session state before crossing the dispatch boundary. Never
        // generate another ID to reconcile a reply lost during profile switch.
        const args = copy({
          operationId: id(),
          expectedSelection: selection,
          review,
        });
        patch({ activationArgs: args });
        try {
          const receipt = await storage.request(
            id(),
            "activateRestoredArchive",
            args,
          );
          acceptReceipt(receipt, args);
          patch({
            activationStatus: copy({
              status: "committed",
              payloadSha256: receipt.payloadSha256,
              receipt,
            }),
          });
        } catch (error) {
          if (code(error) !== "UNKNOWN_OUTCOME") throw error;
          patch({
            notice:
              "Activation reply was lost. Checking the retained operation ID.",
          });
          await resolveActivation(args);
        }
      });
    },
    async checkActivation() {
      return work("checking", async () => {
        if (!state.activationArgs)
          throw new Error("No activation has been dispatched.");
        await resolveActivation(state.activationArgs);
      });
    },
    async release() {
      return work("releasing", async () => {
        idleCandidateAllowed();
        await dropCandidate();
        patch({
          notice:
            "Restore work released. The active archive is unchanged; validated candidate storage is retained.",
        });
      });
    },
    cancel() {
      if (state.busy !== "choosing" && state.busy !== "staging") return;
      abort?.abort();
      if (chooserId) void host.cancel(chooserId).catch(() => {});
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      abort?.abort();
      if (chooserId) void host.cancel(chooserId).catch(() => {});
      await active;
      if (!state.activationArgs && state.job)
        await releaseJob(state.job.jobId).catch(() => {});
      listeners.clear();
    },
  };
}
export type RestoreController = ReturnType<typeof createRestoreController>;
