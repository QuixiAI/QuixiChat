import { useState } from 'react';

/** Presentation only: pending checks retain the last settled announcement in
 * this scope. Inspection freshness and permission to send belong to callers. */
export function CompatibilityAnnouncement({ scope, outcome }: { scope: string; outcome: string | null }) {
  const [settled, setSettled] = useState({ scope, outcome });
  if (settled.scope !== scope || outcome !== null && outcome !== settled.outcome) {
    setSettled({ scope, outcome });
  }
  const text = outcome ?? (settled.scope === scope ? settled.outcome : null);
  return <p className="compatibility-announcement" role="status" aria-atomic="true">{text ?? ''}</p>;
}

export default CompatibilityAnnouncement;
