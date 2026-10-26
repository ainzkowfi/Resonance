/**
 * End-to-end decode self-test.
 *
 * The capability probe lists codec names, which proves a decoder exists but not
 * that a job runs. This builds a second of known audio as a WAV — the format no
 * codec is needed for, so a failure here points at the decode pipeline itself
 * rather than at some container — hands it to the native module, and judges the
 * output: a non-trivial file is what a working decode produces.
 *
 * The signal and the verdict are pure so `scripts/check.mts` covers every
 * branch; only the file handling lives in the native wrapper.
 */

export const SELF_TEST_RATE = 8_000;
export const SELF_TEST_SECONDS = 1;
/** Below this, a "successful" decode produced no usable audio. */
export const MIN_OUTPUT_BYTES = 1024;

/** One second of 440 Hz at half scale, as little-endian 16-bit mono PCM. */
function tone(rate: number, seconds: number): Uint8Array {
  const frames = Math.max(1, Math.round(rate * seconds));
  const pcm = new Uint8Array(frames * 2);
  const view = new DataView(pcm.buffer);

  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16384);
    view.setInt16(i * 2, value, true);
  }
  return pcm;
}

/** The test signal as a mono 16-bit WAV that the decoder reads directly. */
export function selfTestWav(options: { rate?: number; seconds?: number } = {}): Uint8Array {
  const rate = options.rate ?? SELF_TEST_RATE;
  const pcm = tone(rate, options.seconds ?? SELF_TEST_SECONDS);

  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, pcm.length, true);

  const out = new Uint8Array(header.length + pcm.length);
  out.set(header);
  out.set(pcm, header.length);
  return out;
}

export interface DecodeCheckResult {
  ok: boolean;
  /** One line for the settings row and the shared report. */
  message: string;
  bytes: number;
  ms: number;
}

export interface DecodeCheckInput {
  /** Size of the file the native job was asked to write; 0 when it is missing. */
  bytes: number;
  /** Wall time from JS: write to finished decode. */
  ms: number;
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function evaluateDecodeCheck(input: DecodeCheckInput): DecodeCheckResult {
  const { bytes, ms } = input;

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return {
      ok: false,
      message: 'The decoder reported success but wrote no file',
      bytes: 0,
      ms,
    };
  }

  if (bytes < MIN_OUTPUT_BYTES) {
    return {
      ok: false,
      message: `The output was only ${bytes} bytes, too small to be audio`,
      bytes,
      ms,
    };
  }

  return {
    ok: true,
    message: `Decoded the tone to ${kilobytes(bytes)} in ${Math.max(0, Math.round(ms))} ms`,
    bytes,
    ms,
  };
}
