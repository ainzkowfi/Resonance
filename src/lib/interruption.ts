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

/**
 * What the previous status said, so a stop is judged against a transition.
 *
 * `isExternalStop` alone is not enough. It compares the engine's report with
 * the app's intent, and the app's intent stays "playing" across a pause and a
 * resume — so the first status after `play()` is called, which still says
 * `playing: false` because the decoder has not started yet, looked exactly like
 * something else taking the audio. The track was faded out and paused again a
 * moment after the user resumed it.
 *
 * The fix is to only consider a stop that the engine itself performed: it must
 * have been playing on the previous status, and be stopped on this one. A pause
 * the user asked for ends that streak before the next status is judged.
 */
export interface PlaybackWatch {
  /** The engine reported playing on the previous status. */
  enginePlaying: boolean;
  /** When the current continuous stretch of playback began, 0 when stopped. */
  since: number;
}

export const IDLE_WATCH: PlaybackWatch = { enginePlaying: false, since: 0 };

export interface WatchInput {
  playing: boolean;
  isLoaded: boolean;
  isBuffering: boolean;
  didJustFinish: boolean;
  /** The app believes this track should be playing. */
  expectedPlaying: boolean;
  /** Milliseconds since the epoch. */
  now: number;
}

/** Folds one status into the watch and says whether it was an external stop. */
export function watchPlayback(
  watch: PlaybackWatch,
  input: WatchInput,
): { watch: PlaybackWatch; externalStop: boolean } {
  if (input.playing) {
    return {
      watch: {
        enginePlaying: true,
        since: watch.enginePlaying && watch.since > 0 ? watch.since : input.now,
      },
      externalStop: false,
    };
  }

  const wasPlaying = watch.enginePlaying;
  const externalStop =
    wasPlaying &&
    isExternalStop({
      expectedPlaying: input.expectedPlaying,
      playing: false,
      isLoaded: input.isLoaded,
      isBuffering: input.isBuffering,
      didJustFinish: input.didJustFinish,
      msSincePlaying: watch.since > 0 ? input.now - watch.since : 0,
    });

  return { watch: IDLE_WATCH, externalStop };
}
