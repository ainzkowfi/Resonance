/**
 * Silence skipping.
 *
 * The analysis records how much near-silence sits at each end of a track. Short
 * gaps are part of the music (a breath before the first note, a ringing final
 * chord), so only clearly excessive silence is skipped.
 */

/** Nothing shorter than this is ever skipped. */
export const MIN_SILENCE_SECONDS = 2;

/**
 * Where to start instead of 0, or 0 to leave the position alone.
 *
 * Returns 0 when the lead is not worth skipping or the listener is already past
 * it — resuming from a checkpoint must never be undone.
 */
export function leadSkip(lead: number | undefined, position: number): number {
  if (lead == null || !Number.isFinite(lead) || lead < MIN_SILENCE_SECONDS) return 0;
  if (!Number.isFinite(position) || position >= lead) return 0;
  return lead;
}

/**
 * The time at which a track is effectively over, or 0 to let it run out.
 *
 * A track barely longer than its own outro is left alone rather than cut short.
 */
export function tailOut(duration: number, tail: number | undefined): number {
  if (tail == null || !Number.isFinite(tail) || tail < MIN_SILENCE_SECONDS) return 0;
  if (!Number.isFinite(duration) || duration <= tail + 1) return 0;
  return duration - tail;
}
