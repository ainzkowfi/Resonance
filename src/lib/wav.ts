/**
 * Analysis of decoded PCM.
 *
 * The native decoder hands us a mono 16-bit WAV; from those samples we can
 * derive everything the player needs without any further filtering: the peaks
 * for the waveform, the integrated loudness for leveling, and how much
 * near-silence sits at each end.
 *
 * Kept free of native imports so `scripts/check.mts` can exercise it.
 */

export interface WavAnalysis {
  /** Normalised 0..1 peak per column. */
  peaks: number[];
  /**
   * dBFS RMS over non-silent frames.
   *
   * RMS, not EBU R128: it is a good proxy for perceived level and needs no
   * filter FFmpeg build, but it weights bass more heavily than LUFS does, so a
   * bass-heavy master measures a little loud and is trimmed a little more.
   */
  rmsDb: number;
  /** dBFS sample peak. */
  peakDb: number;
  /** Seconds of near-silence before the first audible frame. */
  lead: number;
  /** Seconds of near-silence after the last audible frame. */
  tail: number;
}

/** Frames quieter than this are treated as silence at the edges. */
const SILENCE_DB = -45;
/** Frames quieter than this are left out of the loudness figure. */
const NOISE_FLOOR_DB = -50;
const FRAME_SECONDS = 0.02;

interface Pcm {
  view: DataView;
  /** Byte offset of the first sample. */
  start: number;
  /** Sample count (mono 16-bit). */
  samples: number;
}

function readPcm(bytes: Uint8Array): Pcm | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const start = offset + 8;
      const length = Math.min(size, bytes.byteLength - start);
      if (length < 128) return undefined;
      return { view, start, samples: Math.floor(length / 2) };
    }
    // Chunks are word aligned: an odd size is followed by a pad byte.
    offset += 8 + size + (size % 2);
  }

  return undefined;
}

function barPeaks(pcm: Pcm, barCount: number): number[] | undefined {
  const perBar = Math.max(1, Math.floor(pcm.samples / barCount));
  const raw: number[] = [];
  let loudest = 0;

  for (let bar = 0; bar < barCount; bar++) {
    const from = bar * perBar;
    const to = Math.min(pcm.samples, from + perBar);
    let sum = 0;
    let count = 0;
    for (let i = from; i < to; i++) {
      const value = pcm.view.getInt16(pcm.start + i * 2, true) / 32768;
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

function measure(pcm: Pcm, sampleRate: number) {
  const frameSamples = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frameCount = Math.max(1, Math.ceil(pcm.samples / frameSamples));
  const frames = new Float64Array(frameCount);

  let peak = 0;
  let totalPower = 0;
  let audiblePower = 0;
  let audibleSamples = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const from = frame * frameSamples;
    const to = Math.min(pcm.samples, from + frameSamples);
    let sum = 0;
    let count = 0;
    for (let i = from; i < to; i++) {
      const value = pcm.view.getInt16(pcm.start + i * 2, true) / 32768;
      const magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
      sum += value * value;
      count += 1;
    }

    totalPower += sum;
    const mean = count > 0 ? sum / count : 0;
    const db = mean > 0 ? 10 * Math.log10(mean) : Number.NEGATIVE_INFINITY;
    frames[frame] = db;
    if (db >= NOISE_FLOOR_DB) {
      audiblePower += sum;
      audibleSamples += count;
    }
  }

  const rmsDb =
    audibleSamples > 0
      ? 10 * Math.log10(audiblePower / audibleSamples)
      : pcm.samples > 0
        ? 10 * Math.log10(totalPower / pcm.samples)
        : Number.NEGATIVE_INFINITY;
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY;

  const frameSeconds = frameSamples / sampleRate;
  let leadFrames = 0;
  while (leadFrames < frameCount && frames[leadFrames] < SILENCE_DB) leadFrames += 1;

  let tailFrames = 0;
  while (
    tailFrames < frameCount - leadFrames &&
    frames[frameCount - 1 - tailFrames] < SILENCE_DB
  ) {
    tailFrames += 1;
  }

  return {
    rmsDb: round(rmsDb),
    peakDb: round(peakDb),
    lead: round(leadFrames * frameSeconds),
    tail: round(tailFrames * frameSeconds),
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

/**
 * Peaks plus loudness and edge-silence for a decoded track.
 *
 * @param barCount Columns to reduce the waveform to.
 * @param sampleRate Rate the PCM was decoded at; drives frame and timing maths.
 */
export function analyzeWav(
  bytes: Uint8Array,
  options: { barCount?: number; sampleRate?: number } = {},
): WavAnalysis | undefined {
  const barCount = options.barCount ?? 96;
  const sampleRate = options.sampleRate ?? 8000;
  if (barCount <= 0 || sampleRate <= 0) return undefined;

  const pcm = readPcm(bytes);
  if (!pcm) return undefined;

  const peaks = barPeaks(pcm, barCount);
  if (!peaks) return undefined;

  return { peaks, ...measure(pcm, sampleRate) };
}

/** Peaks only — the waveform's view of the same analysis. */
export function peaksFromWav(bytes: Uint8Array, barCount = 96): number[] | undefined {
  return analyzeWav(bytes, { barCount })?.peaks;
}
