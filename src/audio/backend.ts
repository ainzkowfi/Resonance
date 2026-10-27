import type { EngineStatus } from './types';

/**
 * What the engine needs from a player, and nothing more.
 *
 * The orchestration around playback — queue handoff, leveling gain, crossfade
 * ramps, deferred seeks, the "did it finish" edge — is the same whatever plays
 * the sound, so it lives in `engineBase.ts` and each player library only has to
 * supply these primitives. That is what keeps the two backends from drifting:
 * a fix to the fade ramp cannot land in one of them and miss the other.
 */

export interface LockScreenOptions {
  title: string;
  artist: string;
  album?: string;
  /** Local file URI or a remote URL for the notification artwork. */
  artwork?: string;
  showSeekForward: boolean;
  showSeekBackward: boolean;
  seekForwardIntervalSeconds: number;
  seekBackwardIntervalSeconds: number;
}

/** One open source. Every call is expected to be safe before the load lands. */
export interface EnginePlayer {
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => Promise<void>;
  /** Output gain, 0..1. The engine never asks for more than full scale. */
  setVolume: (volume: number) => void;
  /** Stops and frees this player; further calls are ignored. */
  release: () => void;
  /** Swaps the source, keeping the player. Rejects when it cannot open. */
  replace: (uri: string) => Promise<void>;
  /** Puts this player on the lock screen, or takes it off with `null`. */
  setLockScreen: (options: LockScreenOptions | null) => void;
}

export interface PlayerBackend {
  /** Audio focus, audio mode, notification permission — once per app run. */
  configure: () => Promise<void>;
  /** Opens `uri` and returns the player for it. */
  open: (uri: string) => Promise<EnginePlayer>;
  /**
   * Status for every open player, identified by the player object rather than
   * by position, because a preloaded player is promoted to the current one and
   * its reports have to follow it.
   */
  subscribe: (listener: (player: EnginePlayer, status: EngineStatus) => void) => () => void;
}
