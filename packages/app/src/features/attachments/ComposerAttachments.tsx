import type { ComposerAttachments, ComposerAttachmentsSnapshot } from "./composer-attachments.ts";
import { IMAGE_MEDIA_TYPES, FILE_MEDIA_TYPES, AUDIO_MEDIA_TYPES } from "@quixi/providers";
import "./attachments.css";

const sizeText = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MiB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KiB`
      : `${bytes} bytes`;

/** Staged attachments with image previews and file/audio metadata. Selection
 * goes through the host dialog; drops are handled by the surrounding form. */
export function ComposerAttachmentsView({
  controller,
  snapshot,
  disabled,
  imagesSupported,
  fileMediaTypes = [],
  audioMediaTypes = [],
}: {
  controller: ComposerAttachments;
  snapshot: ComposerAttachmentsSnapshot;
  disabled: boolean;
  imagesSupported: boolean;
  fileMediaTypes?: readonly string[];
  audioMediaTypes?: readonly string[];
}) {
  const locked = disabled || snapshot.busy;
  const filesSupported = fileMediaTypes.some(type => FILE_MEDIA_TYPES.includes(type));
  const audioSupported = audioMediaTypes.some(type => AUDIO_MEDIA_TYPES.includes(type));
  const mediaTypes = [...(imagesSupported ? IMAGE_MEDIA_TYPES : []), ...FILE_MEDIA_TYPES.filter(type => fileMediaTypes.includes(type)), ...AUDIO_MEDIA_TYPES.filter(type => audioMediaTypes.includes(type))];
  return (
    <div className="composer-attachments">
      <div className="composer-attachments-actions">
        <button
          type="button"
          onClick={() => void controller.choose(mediaTypes)}
          disabled={locked || mediaTypes.length === 0}
          aria-describedby="composer-attachments-help"
        >
          {snapshot.busy ? "Attaching…" : filesSupported || audioSupported ? "Attach files" : "Attach image"}
        </button>
        {snapshot.busy && <button type="button" onClick={() => controller.cancelPending()}>Cancel attachment</button>}
        <small id="composer-attachments-help">
          {audioSupported
            ? `${[...(imagesSupported ? ["PNG, JPEG, GIF, WebP"] : []), ...(filesSupported ? ["PDF"] : []), ...(audioMediaTypes.includes("audio/wav") ? ["WAV"] : []), ...(audioMediaTypes.includes("audio/mpeg") ? ["MP3"] : [])].join(", ")} files, up to 20 attachments and 2.5 MiB total per message. Drop files anywhere in the composer.`
            : filesSupported
            ? `${imagesSupported ? "PNG, JPEG, GIF, WebP or PDF" : "PDF"} files, up to 20 attachments and 2.5 MiB total per message. Drop files anywhere in the composer.`
            : imagesSupported
            ? "PNG, JPEG, GIF or WebP images, up to 2.5 MiB per message. Drop images anywhere in the composer."
            : "This model connection does not accept attachments."}
        </small>
      </div>
      {snapshot.items.length > 0 && (
        <ul className="composer-attachment-list" aria-label={filesSupported || audioSupported || snapshot.items.some(item => item.kind !== "Image") ? "Attached files" : "Attached images"}>
          {snapshot.items.map((item) => (
            <li key={item.id}>
              {item.kind === "Image" && item.previewUrl ? <img src={item.previewUrl} alt={item.filename} /> : <span className="composer-attachment-file" aria-hidden="true">{item.kind === "Audio" ? item.mediaType === "audio/wav" ? "WAV" : "MP3" : "PDF"}</span>}
              <span>
                {item.filename} · {item.kind === "File" ? "PDF · " : item.kind === "Audio" ? `${item.mediaType === "audio/wav" ? "WAV" : "MP3"} · ` : ""}{sizeText(item.byteLength)}
              </span>
              <button
                type="button"
                disabled={locked}
                aria-label={`Remove ${item.filename}`}
                onClick={() => void controller.remove(item.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {snapshot.notice && <p role="alert">{snapshot.notice}</p>}
    </div>
  );
}
