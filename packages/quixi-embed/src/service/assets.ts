import { EmbeddingServiceError } from './protocol.ts';

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}
/** Fetch at most `maxBytes`; a longer body or a digest mismatch is refused. */
export async function fetchVerified(url: string, expectedSha256: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new EmbeddingServiceError('assets', 'Invalid asset pin');
  let response: Response;
  try { response = await fetch(url, { ...(signal ? { signal } : {}), cache: 'default' }); }
  catch (error) { throw new EmbeddingServiceError('assets', `Could not download ${describe(url)}: ${(error as Error).message}`); }
  if (!response.ok || !response.body) throw new EmbeddingServiceError('assets', `Asset ${describe(url)} is unavailable (HTTP ${response.status}).`);
  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBytes) throw new EmbeddingServiceError('assets', `Asset ${describe(url)} exceeds its pinned size.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) { await reader.cancel().catch(() => {}); throw new EmbeddingServiceError('assets', `Asset ${describe(url)} exceeds its pinned size.`); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (await sha256Hex(bytes) !== expectedSha256) throw new EmbeddingServiceError('assets', `Asset ${describe(url)} does not match its pinned SHA-256.`);
  return bytes;
}
const describe = (url: string) => { try { return new URL(url, 'http://localhost').pathname.split('/').pop() || url; } catch { return url; } };

/** Verified model bytes from the private OPFS copy, else from the network
 * (then cached). A torn or foreign cached file fails its digest and is replaced. */
export async function loadModelBytes(options: { url: string; sha256: string; bytes: number; cacheDirectory: string | null; signal?: AbortSignal }): Promise<{ bytes: Uint8Array; source: 'cache' | 'network'; cacheWritten: boolean }> {
  const directory = options.cacheDirectory ? await cacheDirectory(options.cacheDirectory) : null;
  const name = `${options.sha256}.qxmodel`;
  if (directory) {
    try {
      const handle = await directory.getFileHandle(name);
      const file = await handle.getFile();
      if (file.size === options.bytes) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (await sha256Hex(bytes) === options.sha256) return { bytes, source: 'cache', cacheWritten: false };
      }
      await directory.removeEntry(name).catch(() => {});
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) { try { await directory.removeEntry(name); } catch { /* absent */ } }
    }
  }
  const bytes = await fetchVerified(options.url, options.sha256, options.bytes, options.signal);
  if (bytes.byteLength !== options.bytes) throw new EmbeddingServiceError('assets', 'Model byte length differs from its pin.');
  let cacheWritten = false;
  if (directory) {
    try {
      const handle = await directory.getFileHandle(name, { create: true }) as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ truncate(size: number): void; write(bytes: Uint8Array, options: { at: number }): number; flush(): void; close(): void }> };
      const access = await handle.createSyncAccessHandle();
      try { access.truncate(0); access.write(bytes, { at: 0 }); access.flush(); cacheWritten = true; }
      finally { access.close(); }
    } catch { cacheWritten = false; /* Quota or unsupported handle: run from memory. */ }
  }
  return { bytes, source: 'network', cacheWritten };
}
async function cacheDirectory(name: string): Promise<FileSystemDirectoryHandle | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new EmbeddingServiceError('assets', 'Invalid cache directory name');
  try {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(name, { create: true });
    return await base.getDirectoryHandle('models', { create: true });
  } catch { return null; }
}
