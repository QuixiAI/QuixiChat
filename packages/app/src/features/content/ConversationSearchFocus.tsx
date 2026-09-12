import { useEffect, useRef } from "react";
import type { ContentAccess } from "./access.ts";
import { ContentPartView } from "./ContentPartView.tsx";
import type { ConversationSearchFocus as Focus } from "./conversation-search.ts";

export function ConversationSearchFocus({
  focus,
  access,
  onClose,
}: {
  focus: Focus;
  access: ContentAccess;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "nearest" });
  }, [focus.chunkId]);
  return (
    <section
      className="search-focused-part"
      aria-label="Selected search content"
      data-focused-part-id={focus.part.id}
    >
      <div className="actions">
        <h2 ref={heading} tabIndex={-1}>
          Search match
        </h2>
        <button onClick={onClose}>Close selected content</button>
      </div>
      <p>Message part {focus.part.order + 1}</p>
      {focus.filename && (
        <div className="search-matched-filename">
          <p>Matched filename</p>
          <p className="excerpt" data-search-field="filename">
            {focus.filename.startUTF16 > 0 ? "…" : ""}
            <mark>{focus.filename.text}</mark>
            {focus.filename.endUTF16 < focus.filename.totalUTF16 ? "…" : ""}
          </p>
        </div>
      )}
      <ContentPartView key={focus.part.id} part={focus.part} access={access} />
    </section>
  );
}
