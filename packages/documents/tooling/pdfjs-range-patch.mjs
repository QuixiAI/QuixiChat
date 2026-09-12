import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Transport scheduling only. PDF object/stream decoding stays upstream.
export const upstreamSha256 = 'f2870db902eaff8397442c912b69459980ac91f6f4b5ed827167b12cf7057930';
export const patchedSha256 = '5de8099723be073084ade9e371597083efa230d74e199c7f5fc1fdd675cf2671';
export const rangeBytes = 1024 * 1024;
const anchor = '  async sendRequest(begin, end) {\n    const rangeReader = this.pdfStream.getRangeReader(begin, end);';
export const replacement = `  // Quixi range transport patch 1: retain complete range-reader replies,
  // but never ask the display worker to materialize an unbounded range group.
  async sendRequest(begin, end) {
    for (let offset = begin; offset < end; offset += ${rangeBytes}) {
      if (this.#aborted) return;
      await this.quixiSendBoundedRequest(offset, Math.min(end, offset + ${rangeBytes}));
    }
  }
  async quixiSendBoundedRequest(begin, end) {
    const rangeReader = this.pdfStream.getRangeReader(begin, end);`;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function patchParser(source) {
  if (sha256(source) !== upstreamSha256) throw new Error('Unexpected PDF.js parser bytes; review the transport patch before upgrading.');
  if (source.split(anchor).length !== 2) throw new Error('PDF.js range patch anchor must occur exactly once.');
  const patched = source.replace(anchor, replacement);
  if (sha256(patched) !== patchedSha256) throw new Error('PDF.js range patch output changed; review and pin its new digest.');
  return patched;
}

export async function installPatch() {
  const require = createRequire(import.meta.url);
  const path = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
  const current = await readFile(path, 'utf8');
  // Reversing the exact local change must reproduce the pinned upstream hash.
  // This also makes repeated npm installs idempotent without accepting drift.
  const original = current.includes(replacement) ? current.replace(replacement, anchor) : current;
  const patched = patchParser(original);
  if (current !== original && current !== patched) throw new Error('Unexpected patched PDF.js parser bytes.');
  if (current !== patched) await writeFile(path, patched);
  return { upstreamSha256, parserSha256: sha256(patched), rangeBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Verified PDF.js bounded range transport:', await installPatch());
}
