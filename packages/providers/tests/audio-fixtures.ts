/** Disposable generated fixtures: PCM silence and one MPEG-1 Layer III frame.
 * No downloaded recording or private speech is used by transport qualification. */
export function audioFixture(format: 'wav' | 'mp3'): Uint8Array<ArrayBuffer> {
  if (format === 'mp3') {
    const bytes = new Uint8Array(417);
    bytes.set([0xff, 0xfb, 0x90, 0x00]); // MPEG-1 Layer III, 128 kbps, 44.1 kHz.
    return bytes;
  }
  const samples = 800, bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => bytes.set(new TextEncoder().encode(value), at);
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  return bytes;
}
