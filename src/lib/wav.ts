/**
 * Peak extraction for waveforms.
 *
 * FFmpeg hands us a mono 16-bit WAV; all this needs to do is walk the RIFF
 * chunks to find `data`, then reduce the samples to one RMS value per column.
 * Kept free of native imports so it can be checked in `scripts/check.mts`.
 */
export function peaksFromWav(bytes: Uint8Array, barCount = 96): number[] | undefined {
  if (barCount <= 0) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      dataStart = offset + 8;
      dataLength = Math.min(size, bytes.byteLength - dataStart);
      break;
    }
    // Chunks are word aligned: an odd size is followed by a pad byte.
    offset += 8 + size + (size % 2);
  }

  if (dataStart < 0 || dataLength < 128) return undefined;

  const samples = Math.floor(dataLength / 2);
  const perBar = Math.max(1, Math.floor(samples / barCount));
  const raw: number[] = [];
  let loudest = 0;

  for (let bar = 0; bar < barCount; bar++) {
    const start = bar * perBar;
    const end = Math.min(samples, start + perBar);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const value = view.getInt16(dataStart + i * 2, true) / 32768;
      sum += value * value;
      count += 1;
    }
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;
    if (rms > loudest) loudest = rms;
    raw.push(rms);
  }

  if (loudest <= 0) return undefined;

  // A gentle curve: quiet passages stay visible, loud ones do not flatten out.
  return raw.map((value) => Math.round(Math.pow(value / loudest, 0.72) * 1000) / 1000);
}
