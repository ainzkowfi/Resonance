/**
 * Did something outside the app stop playback?
 *
 * Neither platform hands JavaScript an interruption event through
 * `expo-audio`: iOS pauses the player on an `AVAudioSession` interruption (and
 * may resume it afterwards), Android reacts to audio-focus loss, and all the app
 * sees is a status where `playing` became false. This rule reads that status
 * together with what the app itself believes, so an interruption can be told
 * apart from a pause the user asked for, the end of a track, and the ordinary
 * "not playing yet" of a source that is still loading.
 *
 * Deliberately conservative: a false positive pauses music for no reason, so it
 * waits until the track has actually been playing for a moment and the platform
 * reports the source as loaded and not buffering.
 *
 * Kept pure so `scripts/check.mts` covers it.
 */

/** How long a track must have been playing before a stop counts as external. */
export const INTERRUPTION_GRACE_MS = 750;

export interface StopSignal {
  /** The app believed this track was playing. */
  expectedPlaying: boolean;
  /** What the engine reports now. */
  playing: boolean;
  isLoaded: boolean;
  isBuffering: boolean;
  /** The track reached its end; that is a finish, not an interruption. */
  didJustFinish: boolean;
  /** Milliseconds since the track first reported playing, 0 when never. */
  msSincePlaying: number;
}

export function isExternalStop(signal: StopSignal): boolean {
  if (!signal.expectedPlaying) return false;
  if (signal.playing) return false;
  if (!signal.isLoaded || signal.isBuffering) return false;
  if (signal.didJustFinish) return false;
  return signal.msSincePlaying >= INTERRUPTION_GRACE_MS;
}
