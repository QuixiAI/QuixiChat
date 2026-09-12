import type { AdoptableFile, HostClient, HostFile, StorageClient } from "@quixi/core/contracts";
import { COMPOSER_ATTACHMENT_LIMITS, attachmentMediaTypes, stageAttachment, type StagedAttachment } from "./staging.ts";

export interface StagedAttachmentView {
  id: string;
  kind: "Image" | "File" | "Audio";
  filename: string;
  byteLength: number;
  mediaType: string;
  previewUrl: string | null;
}
export type StagedImageView = StagedAttachmentView;
export interface ComposerAttachmentsSnapshot { items: readonly StagedAttachmentView[]; busy: boolean; notice: string | null }
const id = () => crypto.randomUUID();
const view = (item: StagedAttachment): StagedAttachmentView => ({ id: item.id, kind: item.kind, filename: item.filename, byteLength: item.byteLength, mediaType: item.mediaType, previewUrl: item.previewUrl });
type Selection = { epoch: number; controller: AbortController; mediaTypes: readonly string[] };

/** Verified original attachments stay local until a message publishes their
 * worker stages. Only one selection can hold attachment buffers at a time. */
export function createComposerAttachments({ storage, host }: { storage: StorageClient; host: HostClient }) {
  const listeners = new Set<() => void>(), items: StagedAttachment[] = [];
  let state: ComposerAttachmentsSnapshot = Object.freeze({ items: [], busy: false, notice: null });
  let busy = false, disposed = false, epoch = 0, active: Selection | null = null;
  const publish = (change: Partial<ComposerAttachmentsSnapshot> = {}) => {
    state = Object.freeze({ ...state, items: items.map(view), ...change });
    for (const listener of listeners) listener();
  };
  const current = (selection: Selection) => !disposed && selection.epoch === epoch && !selection.controller.signal.aborted;
  const totalBytes = () => items.reduce((sum, item) => sum + item.byteLength, 0);
  async function discard(item: StagedAttachment) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    await storage.request(id(), "discardBlobTransfer", { transferId: item.transferId }).catch(() => undefined);
  }
  async function stageAll(files: readonly HostFile[], selection: Selection) {
    const refusals: string[] = [];
    try {
      for (const file of files) {
        if (!current(selection)) break;
        try {
          if (items.length >= COMPOSER_ATTACHMENT_LIMITS.attachmentsPerMessage) { refusals.push(`A message carries at most ${COMPOSER_ATTACHMENT_LIMITS.attachmentsPerMessage} attachments.`); continue; }
          if (file.byteLength !== null && file.byteLength > 0 && file.byteLength <= COMPOSER_ATTACHMENT_LIMITS.attachmentBytes && totalBytes() + file.byteLength > COMPOSER_ATTACHMENT_LIMITS.attachmentBytes) { refusals.push("Attachments are limited to 2.5 MiB in total per message."); continue; }
          const staged = await stageAttachment(storage, host, file, () => !current(selection), selection.mediaTypes, selection.controller.signal);
          if (!current(selection)) { await discard(staged); break; }
          items.push(staged); publish();
        } catch (error) {
          if (current(selection)) refusals.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      // A cancelled picker may still return several handles. Release even the
      // files that were never opened, rather than stopping at the current item.
      await Promise.all(files.map(file => host.releaseFile(id(), file.id).catch(() => undefined)));
    }
    return refusals;
  }
  async function run(mediaTypes: readonly string[] | undefined, choose: (requestId: string, types: readonly string[]) => Promise<readonly HostFile[]>) {
    if (busy || disposed) return;
    const selection: Selection = { epoch, controller: new AbortController(), mediaTypes: attachmentMediaTypes(mediaTypes) };
    active = selection; busy = true; publish({ busy: true, notice: null });
    const requestId = id(), cancelPicker = () => { void host.cancel?.(requestId).catch(() => undefined); };
    selection.controller.signal.addEventListener("abort", cancelPicker, { once: true });
    let refusals: string[] = [];
    try {
      if (!selection.mediaTypes.length) refusals = ["This model connection does not accept the selected attachment types."];
      else {
        const files = await choose(requestId, selection.mediaTypes);
        selection.controller.signal.removeEventListener("abort", cancelPicker);
        refusals = await stageAll(files, selection);
      }
    } catch (error) {
      if (current(selection)) refusals = [error instanceof Error ? error.message : String(error)];
    } finally {
      selection.controller.signal.removeEventListener("abort", cancelPicker);
      active = null; busy = false;
      if (!disposed) publish({ busy: false, notice: current(selection) && refusals.length ? refusals.join(" ") : null });
    }
  }
  function cancelPending() {
    epoch++; active?.controller.abort();
    if (!disposed) publish({ notice: null });
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    /** Defaults to images for older callers; current model capabilities may opt into PDFs and audio. */
    choose: (mediaTypes?: readonly string[]) => run(mediaTypes, (requestId, types) => host.chooseFiles(requestId, { multiple: true, mediaTypes: [...types] })),
    adopt: (files: readonly AdoptableFile[], mediaTypes?: readonly string[]) => run(mediaTypes, requestId => files.length ? host.adoptFiles(requestId, files) : Promise.resolve([])),
    async remove(itemId: string) {
      if (busy || disposed) return;
      const index = items.findIndex(item => item.id === itemId); if (index < 0) return;
      const [item] = items.splice(index, 1); publish({ notice: null }); await discard(item!);
    },
    staged: (): readonly StagedAttachment[] => [...items],
    consumed(ids: readonly string[]) {
      for (const itemId of ids) { const index = items.findIndex(item => item.id === itemId); if (index < 0) continue; const [item] = items.splice(index, 1); if (item!.previewUrl) URL.revokeObjectURL(item!.previewUrl!); }
      publish();
    },
    /** Invalidate only the pending selection when the selected model changes. */
    cancelPending,
    async clear() {
      cancelPending(); const removed = items.splice(0, items.length); publish({ notice: null }); await Promise.all(removed.map(discard));
    },
    async dispose() {
      if (disposed) return;
      disposed = true; epoch++; active?.controller.abort();
      const removed = items.splice(0, items.length); publish({ busy: false, notice: null }); listeners.clear();
      await Promise.all(removed.map(discard));
    },
  };
}
export type ComposerAttachments = ReturnType<typeof createComposerAttachments>;
