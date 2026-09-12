import { useEffect, useState } from 'react';
import type { StorageClient } from '@quixi/core/contracts';
import type { Generation, ThreadEvent } from '@quixi/core/model';

export interface CompareCandidate { generationId: string; outputId: string; provider: string; connection: string; model: string }
export const compareCandidates = (event: ThreadEvent): CompareCandidate[] => {
  const details = event.details as { candidates?: unknown };
  return Array.isArray(details.candidates) ? details.candidates.filter((item): item is CompareCandidate => !!item && typeof item === 'object' && typeof (item as CompareCandidate).generationId === 'string' && typeof (item as CompareCandidate).outputId === 'string') : [];
};
const statusLabel: Record<Generation['status'], string> = { streaming: 'Answering…', complete: 'Complete', stopped: 'Stopped', failed: 'Failed', cancelled: 'Cancelled', partial: 'Partial' };
const cost = (generation: Generation) => generation.estimatedCost ? `${generation.estimatedCost.amount} ${generation.estimatedCost.currency} (estimate)` : null;
/** Product §39 compare view for one user turn: each candidate answer with its
 * own status, usage and cost, selectable and continuable as a branch. The
 * candidates come from the recorded Compare event; their generations are
 * re-read on every storage change, so streaming status stays live. */
export function CompareCandidates({ storage, event, leaf, pathIds, providerLabel, disabled, onSelect }: { storage: StorageClient; event: ThreadEvent; leaf: string | null; pathIds: ReadonlySet<string>; providerLabel: (connection: string, provider: string) => string; disabled: boolean; onSelect: (outputId: string) => void }) {
  const candidates = compareCandidates(event);
  const [generations, setGenerations] = useState<Record<string, Generation | null>>({});
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const entries = await Promise.all(candidates.map(async candidate => [candidate.generationId, (await storage.request(crypto.randomUUID(), 'readEntity', { collection: 'generations', id: candidate.generationId }).catch(() => null)) as unknown as Generation | null] as const));
      if (active) setGenerations(Object.fromEntries(entries));
    };
    void read();
    const unsubscribe = storage.onChange(() => { clearTimeout(timer); timer = setTimeout(() => { if (active) void read(); }, 150); });
    return () => { active = false; clearTimeout(timer); unsubscribe(); };
  }, [storage, event.id]);
  if (!candidates.length) return null;
  return <section className="compare-candidates" aria-label={`Compared answers, ${candidates.length} candidates`} data-testid="compare-candidates">
    <h3>Compared answers</h3>
    <p className="muted">Each answer is its own branch; every one is kept. Select one to continue from it, or continue several in turn.</p>
    <ol>
      {candidates.map(candidate => {
        const generation = generations[candidate.generationId] ?? null;
        const selected = pathIds.has(candidate.outputId) || leaf === candidate.outputId;
        return <li key={candidate.generationId} data-outcome={generation?.status ?? 'pending'} data-selected={selected ? 'true' : 'false'}>
          <strong>{providerLabel(candidate.connection, candidate.provider)} · {candidate.model}</strong>{' '}
          <span className="compare-status">{generation ? statusLabel[generation.status] : 'Starting…'}</span>
          {generation && (generation.tokensOut !== null || cost(generation)) && <span className="muted"> · {generation.tokensIn ?? '?'} in / {generation.tokensOut ?? '?'} out{cost(generation) ? ` · ${cost(generation)}` : ''}</span>}
          {selected ? <span className="compare-selected"> · Selected</span> : <button type="button" disabled={disabled} onClick={() => onSelect(candidate.outputId)}>Select this answer</button>}
        </li>;
      })}
    </ol>
  </section>;
}
