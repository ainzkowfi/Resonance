/**
 * When to stop waiting for a track to open.
 *
 * Not every refusal reaches JavaScript. `expo-audio` exposes a `status.error`,
 * and a load can also reject outright, but a source the platform cannot parse
 * may simply never become `isLoaded` — the player sits there looking paused.
 * That silence is the case this covers: if nothing has loaded, nothing has
 * played, and the position has not moved, the track is treated as failed.
 *
 * The rule is pure so the silent case is covered by `scripts/check.mts`; the
 * timer itself lives with the player.
 */

/** Generous next to a local file: a device that needs this long is stuck. */
export const LOAD_WATCHDOG_MS = 10_000;

export interface LoadProgress {
  /** The source finished opening. */
  loaded: boolean;
  /** Seconds played, as reported by the engine. */
  currentTime: number;
  /** The engine is actually playing. */
  playing: boolean;
  /** Native error text, when the platform supplied one. */
  error?: string | null;
}

/**
 * The reason to treat a load as failed, or `undefined` while it is fine.
 *
 * A reported error means the failure path already ran, so it deliberately
 * returns `undefined` here rather than reporting the same refusal twice.
 */
export function stalledLoadFailure(progress: LoadProgress): string | undefined {
  if (progress.error) return undefined;
  if (progress.loaded || progress.playing || progress.currentTime > 0) return undefined;
  return 'The player never finished opening this file.';
}
