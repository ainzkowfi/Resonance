/**
 * Volume leveling maths.
 *
 * `expo-audio` exposes `player.volume` in the range 0–1, so a track can only be
 * turned **down**. Leveling therefore aims at the library's median loudness:
 * anything louder is attenuated to it, anything quieter is left alone. That
 * halves the spread between a loud master and a quiet one instead of pretending
 * quiet tracks can be raised.
 */

/** Used until enough tracks have been measured. Typical of a modern master. */
export const FALLBACK_TARGET_DB = -16;
/** Below this many measurements a median is not meaningful. */
export const MIN_SAMPLES = 5;
/** Never pull a track down further than this. */
export const MAX_ATTENUATION_DB = 18;

/** Median of the measured loudness values, or the fallback while data is thin. */
export function targetFromSamples(samples: readonly number[]): number {
  const usable = samples.filter((value) => Number.isFinite(value) && value < 0);
  if (usable.length < MIN_SAMPLES) return FALLBACK_TARGET_DB;

  const sorted = [...usable].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(median * 10) / 10;
}

function clampGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db >= 0) return 0;
  return Math.max(-MAX_ATTENUATION_DB, db);
}

/**
 * Gain for one track, in dB.
 *
 * Measured loudness wins; a ReplayGain tag is the fallback for tracks that have
 * not been analysed yet. Positive gain is discarded — the player cannot boost.
 */
export function trackGainDb(input: {
  rmsDb?: number;
  tagGainDb?: number;
  targetDb: number;
}): number {
  if (input.rmsDb != null && Number.isFinite(input.rmsDb)) {
    return clampGain(input.targetDb - input.rmsDb);
  }
  if (input.tagGainDb != null && Number.isFinite(input.tagGainDb)) {
    return clampGain(input.tagGainDb);
  }
  return 0;
}

/** dB → the player's 0–1 volume. */
export function volumeForGain(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 1;
  return Math.min(1, Math.max(0, Math.pow(10, gainDb / 20)));
}
