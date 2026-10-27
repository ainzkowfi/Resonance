import type { HandoffTiming } from '../lib/handoff';
import type { Track } from '../types/track';

/**
 * The playback contract.
 *
 * The store drives playback through `PlaybackEngine` and never through a
 * particular player library, so there can be more than one implementation
 * behind the same name — `expo-audio` today, a native player next to it — and
 * the app can switch between them without the queue, the lock screen or the
 * crossfade knowing which one is running.
 *
 * A status report is the whole of what an engine tells the store about sound.
 * Everything downstream — the watchdog, the interruption notice, "advance when
 * the track ends" — is derived from these fields, so an implementation has to
 * report them honestly rather than optimistically.
 */

export interface EngineStatus {
  currentTime: number;
  duration: number;
  playing: boolean;
  didJustFinish: boolean;
  isLoaded: boolean;
  isBuffering: boolean;
  /** Native playback error, when the platform reports one. */
  error?: string | null;
}

export type StatusListener = (status: EngineStatus) => void;
export type HandoffListener = (timing: HandoffTiming) => void;

export interface LoadOptions {
  /** Start playing as soon as the source is open. Defaults to the caller. */
  autoplay?: boolean;
  /** Seconds to start at, applied once the source is loaded. */
  startAt?: number;
}

export interface CrossfadeOptions extends LoadOptions {
  /** Length of the blend in seconds. A hard cut is taken for 0. */
  seconds: number;
  /** Leveling gain to apply to the incoming track as it is promoted. */
  gain?: number;
}

export interface PlaybackEngine {
  setStatusListener: (listener: StatusListener | null) => void;
  setHandoffListener: (listener: HandoffListener | null) => void;

  /** Prepares audio focus and background playback; safe to call more than once. */
  configure: () => Promise<void>;

  load: (track: Track, options?: LoadOptions) => Promise<void>;
  /** Opens a track in a hidden player so the next handoff is just a `play()`. */
  prepare: (track: Track) => void;
  releaseStandby: () => void;
  crossfadeTo: (track: Track, options: CrossfadeOptions) => Promise<void>;

  updateLockScreenMetadata: (track: Track) => void;
  /** Ramps down and pauses, leaving the position where it was. */
  fadeOutAndPause: (durationMs?: number) => Promise<void>;
  /** Leveling gain for the loaded track; multiplied with any active fade. */
  setLevelGain: (gain: number) => void;

  play: () => void;
  pause: () => void;
  seek: (seconds: number) => Promise<void>;
  replay: () => void;
  unload: () => void;
}
