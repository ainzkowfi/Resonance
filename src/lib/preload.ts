/**
 * When to open the next track ahead of time.
 *
 * Most of the gap between tracks is the player being created and its decoder
 * starting. Opening the next source into a hidden player shortly before the
 * boundary moves that work off the critical path, so the handoff becomes a
 * `play()` on something that is already open.
 *
 * The window is deliberately short: a preloaded player holds a decoder for as
 * long as it lives, and there is no point paying for that across a whole album
 * track when the last few seconds are enough.
 */

/** Seconds of the outgoing track that remain when the next one is opened. */
export const PRELOAD_LEAD_SECONDS = 15;

export function shouldPreload(input: {
  duration: number;
  currentTime: number;
  /** True once this track's successor has already been prepared. */
  prepared: boolean;
}): boolean {
  if (input.prepared) return false;
  if (!Number.isFinite(input.duration) || input.duration <= 0) return false;
  if (!Number.isFinite(input.currentTime) || input.currentTime < 0) return false;

  const remaining = input.duration - input.currentTime;
  return remaining > 0 && remaining <= PRELOAD_LEAD_SECONDS;
}
