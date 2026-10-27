import { ExpoAudioEngine } from './expoAudioEngine';
import type { PlaybackEngine } from './types';

export type {
  CrossfadeOptions,
  EngineStatus,
  HandoffListener,
  LoadOptions,
  PlaybackEngine,
  StatusListener,
} from './types';

/**
 * The engine the whole app plays through.
 *
 * One object, so the store, the lock screen and the crossfade never have to
 * know which player library is underneath; picking the implementation happens
 * here and nowhere else. Every `PlaybackEngine` member is reached through this
 * binding, which is why swapping it does not touch a single screen.
 */
export const audioEngine: PlaybackEngine = new ExpoAudioEngine();
