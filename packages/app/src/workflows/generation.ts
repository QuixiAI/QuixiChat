import { acquireGenerationLease } from '@quixi/storage/client';
import { startGeneration } from '@quixi/providers';
import type { GenerationRun, GenerationRunOptions } from '@quixi/providers';

export interface CoordinatedGenerationOptions extends GenerationRunOptions {
  /** Must identify the archive used by storage and reconnectStorage. */
  archiveId: string;
}

/** Own the producer in the HTTP context before any attempt can become durable.
 * Worker ownership may move independently. A closed/crashed producer context
 * releases its Web Lock, allowing durable recovery of its committed prefix.
 */
export async function startCoordinatedGeneration(options: CoordinatedGenerationOptions): Promise<GenerationRun> {
  const generationId = options.attempt.generation.id;
  const producerId = options.nextId();
  const lease = await acquireGenerationLease(options.archiveId, generationId);
  const args = { generationId, producerId };
  const settle = async () => {
    try { await options.storage.request(options.nextId(), 'releaseGenerationProducer', args); }
    catch { /* The durable row plus released Web Lock is enough for recovery. */ }
    finally { await lease.release(); }
  };
  try {
    await options.storage.request(options.nextId(), 'registerGenerationProducer', args);
    const run = startGeneration(options);
    return { cancel: () => run.cancel(), result: run.result.finally(settle) };
  } catch (error) {
    await settle();
    throw error;
  }
}
