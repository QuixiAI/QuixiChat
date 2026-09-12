import { useSyncExternalStore } from "react";
import type { ArchiveActivationReceipt } from "@quixi/core/contracts";
import type { RestoreController } from "./restore-controller.ts";
import { useFocusRecovery } from '../accessibility/useFocusRecovery.ts';

const phases = {
  snapshot: "Preparing archive",
  encoding: "Preparing archive",
  receiving: "Reading selected file",
  container_validation: "Checking archive files",
  schema_validation: "Checking database format",
  record_validation: "Checking history",
  blob_validation: "Verifying available attachment bytes",
  ready: "Candidate validated",
  cleanup: "Cleaning temporary work",
};
/** Opening belongs to the parent app session and runs after controller work has
 * ended. It may dispose this controller without awaiting its own active job. */
export function RestorePanel({
  controller,
  onOpenRestored,
}: {
  controller: RestoreController;
  onOpenRestored: (receipt: ArchiveActivationReceipt) => void;
}) {
  const focus = useFocusRecovery();
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const candidate = state.review?.candidate ?? state.job?.candidate;
  const dispatched = state.activationArgs !== null;
  return (
    <section aria-labelledby="restore-title" ref={focus.rootRef} onFocusCapture={focus.onFocusCapture}>
      <h2 id="restore-title" ref={focus.anchorRef} tabIndex={-1} className="focus-anchor">Restore a Quixi archive</h2>
      <p>
        Choose a portable Quixi archive. Its history and available attachments
        are validated in separate storage before you review a replacement. Open
        JSONL/Markdown exports cannot be restored here.
      </p>
      <p>
        The current archive remains selected until you explicitly confirm
        replacement. The previous archive is retained after a successful
        replacement.
      </p>
      <div className="actions">
        <button
          disabled={!!state.busy || dispatched}
          onClick={() => void controller.choose()}
        >
          Choose portable archive
        </button>
        {(state.busy === "choosing" || state.busy === "staging") && (
          <button onClick={() => controller.cancel()}>
            Cancel restore preparation
          </button>
        )}
      </div>
      {state.job && (
        <div className="restore-progress">
          <div className="restore-phase" role="status" aria-atomic="true"><h3>{phases[state.job.phase]}</h3></div>
          <p>
            {state.job.completedRecords.toLocaleString()} records checked ·{" "}
            {state.job.completedBytes.toLocaleString()} bytes processed
            {state.job.totalBytes !== null
              ? ` of ${state.job.totalBytes.toLocaleString()}`
              : ""}
          </p>
        </div>
      )}
      {candidate && (
        <section aria-label="Restore candidate review">
          <h3>{state.review ? "Review replacement" : "Validated candidate"}</h3>
          <p>{state.sourceName ?? "Previously validated portable archive"}</p>
          <dl>
            <dt>Schema</dt>
            <dd>
              {state.job?.sourceSchemaVersion != null &&
              state.job.sourceSchemaVersion !== candidate.schemaVersion
                ? `${candidate.schemaVersion}, upgraded in this candidate from schema ${state.job.sourceSchemaVersion}; the archive file is unchanged`
                : String(candidate.schemaVersion)}
            </dd>
            <dt>History records</dt>
            <dd>{candidate.canonicalRecords.toLocaleString()}</dd>
            <dt>Available stored files</dt>
            <dd>{candidate.blobCount.toLocaleString()}</dd>
            <dt>Available file bytes</dt>
            <dd>{candidate.blobBytes.toLocaleString()}</dd>
            <dt>Unfinished responses</dt>
            <dd>{candidate.streamingGenerations.toLocaleString()}</dd>
          </dl>
          <p>
            Saved partial responses are kept. Provider requests are not resumed.
            Missing attachment bytes remain unavailable.
          </p>
          {state.review && (
            <p>
              This replaces the archive currently open in this session. New
              history or a changed archive selection requires another review.
            </p>
          )}
          {!dispatched && (
            <div className="actions">
              <button
                disabled={!!state.busy}
                onClick={() => void controller.prepareReview()}
              >
                {state.review ? "Review again" : "Prepare replacement review"}
              </button>
              {state.review && (
                <button
                  className="primary"
                  disabled={!!state.busy}
                  onClick={() => void controller.activate()}
                >
                  I reviewed this candidate — replace active archive
                </button>
              )}
              <button
                disabled={!!state.busy}
                onClick={() => void controller.release()}
              >
                Release restore work
              </button>
            </div>
          )}
        </section>
      )}
      {dispatched && !state.committedReceipt && (
        <div>
          <p>
            This replacement review is retained while its outcome is checked. A
            second replacement will not be sent.
          </p>
          <button
            disabled={!!state.busy}
            onClick={() => void controller.checkActivation()}
          >
            Check activation outcome
          </button>
        </div>
      )}
      {state.committedReceipt && (
        <div className="actions">
          <button
            className="primary"
            disabled={!!state.busy}
            onClick={() => onOpenRestored(state.committedReceipt!)}
          >
            Open restored archive
          </button>
        </div>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.notice && <p role="status">{state.notice}</p>}
    </section>
  );
}
