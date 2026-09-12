import type { RegionalProcessingEvidence } from '@quixi/core/contracts';

export const REGIONAL_RELAY_LIMITS = Object.freeze({ responseBytes: 4096, timeoutMs: 10_000 });
/** An authenticated, content-free declaration check. The operator declaration
 * establishes configuration agreement, not independently measured geography. */
export async function verifyRegionalRelay(evidence: RegionalProcessingEvidence, token: Uint8Array, signal?: AbortSignal): Promise<void> {
  const relay = evidence.relay;
  if (!relay) throw new Error('Regional relay evidence is missing.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, REGIONAL_RELAY_LIMITS.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(new URL('/v1/regional-configuration', relay.origin), {
      method: 'POST', headers: { Authorization: `Bearer ${new TextDecoder().decode(token)}`, 'X-Quixi-Destination': relay.destinationId },
      credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw new Error('Regional relay declaration unavailable.');
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > REGIONAL_RELAY_LIMITS.responseBytes)) {
      await response.body.cancel(); throw new Error('Regional relay declaration exceeds its limit.');
    }
    reader = response.body.getReader();
    const bytes = new Uint8Array(REGIONAL_RELAY_LIMITS.responseBytes);
    let used = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.byteLength > bytes.byteLength) throw new Error('Regional relay declaration exceeds its limit.');
      bytes.set(chunk.value, used); used += chunk.value.byteLength;
    }
    const actual: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    const expected = { version: 1, configurationId: relay.configurationId, operator: relay.operator, region: relay.region, destinationId: relay.destinationId, upstreamOrigin: evidence.upstreamOrigin };
    if (!actual || typeof actual !== 'object' || Array.isArray(actual) || Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => (actual as Record<string, unknown>)[key] !== value)) throw new Error('Regional relay configuration does not match the reviewed destination.');
    if (controller.signal.aborted) throw new Error('Regional relay verification was cancelled.');
  } catch {
    // Never propagate response text, credentials, or arbitrary server errors.
    throw new Error('Regional relay verification failed. Check the operator, processing region and configuration identity.');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await reader?.cancel().catch(() => {}); reader?.releaseLock(); controller.abort();
  }
}
