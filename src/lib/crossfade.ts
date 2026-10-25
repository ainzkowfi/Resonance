/**
 * Crossfade maths.
 *
 * Crossfading happens in the player, not in FFmpeg: the packaged build has no
 * `afade`/`acrossfade` filter and `volume` is a static gain, so a blended
 * junction cannot be rendered offline. The engine runs two players and ramps
 * their volumes instead.
 */

/** Long enough to notice, short enough to stay a detail. */
export const MAX_CROSSFADE_SECONDS = 12;

/** Whole seconds, clamped into the supported range. 0 means "off". */
export function normalizeCrossfade(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_CROSSFADE_SECONDS, Math.round(seconds));
}

/**
 * When to start the next track so the blend lands exactly on the boundary, or
 * 0 when the track is too short to blend without skipping straight through it.
 */
export function crossfadeStart(duration: number, crossfade: number): number {
  if (!Number.isFinite(duration) || !Number.isFinite(crossfade) || crossfade <= 0) return 0;
  // A track that is barely longer than twice the blend would trigger another
  // advance the moment it starts.
  if (duration <= crossfade * 2) return 0;
  return duration - crossfade;
}
