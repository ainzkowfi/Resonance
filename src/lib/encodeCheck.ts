/**
 * End-to-end export self-test.
 *
 * The capability probe parses `-filters`, `-encoders` and `-muxers`, which
 * proves a component is compiled in but not that a job runs. This builds a
 * second of known audio, hands it to the binary, and judges the file that comes
 * back: if an AAC/MP4 round trip works, clip export is feasible on this device,
 * and if it does not, the report says so instead of leaving it to a guess.
 *
 * The input is a WAV rather than raw PCM on purpose. A WAV needs only the `wav`
 * demuxer and the `pcm_s16le` decoder, both documented as included, so a failure
 * points at the encoder or the muxer — the two unknowns — rather than at an
 * input format the build may never have needed.
 *
 * The signal and the verdict are pure so `scripts/check.mts` covers every
 * branch; only the file and process handling lives in the native wrapper.
 */

export const SELF_TEST_RATE = 8_000;
export const SELF_TEST_SECONDS = 1;
/** Below this, a "successful" encode produced no usable audio. */
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

/** The test signal as a mono 16-bit WAV that FFmpeg can read directly. */
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

export interface ExportCheckResult {
  ok: boolean;
  /** One line for the settings row and the shared report. */
  message: string;
  bytes: number;
  ms: number;
}

export interface ExportCheckInput {
  returnCode: number;
  /** Size of the file FFmpeg was asked to write; 0 when it is missing. */
  bytes: number;
  /** Session duration reported by the native module. */
  ms: number;
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function evaluateExportCheck(input: ExportCheckInput): ExportCheckResult {
  const { returnCode, bytes, ms } = input;

  if (!Number.isFinite(returnCode) || returnCode !== 0) {
    return {
      ok: false,
      message: `FFmpeg exited with code ${returnCode}`,
      bytes,
      ms,
    };
  }

  if (!Number.isFinite(bytes) || bytes <= 0) {
    return {
      ok: false,
      message: 'FFmpeg reported success but wrote no file',
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
    message: `AAC/M4A round trip wrote ${kilobytes(bytes)} in ${Math.max(0, Math.round(ms))} ms`,
    bytes,
    ms,
  };
}
