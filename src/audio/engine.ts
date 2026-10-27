import { useSyncExternalStore } from 'react';

import { describeError, useDiagnosticsStore } from '../store/diagnostics';
import type { Track } from '../types/track';
import { ExpoAudioEngine } from './expoAudioEngine';
import { NativeAudioEngine, nativePlayerLoadFailure, nativePlayerModule } from './nativeBackend';
import type {
  CrossfadeOptions,
  EngineSource,
  HandoffListener,
  LoadOptions,
  PlaybackEngine,
  StatusListener,
} from './types';

export type {
  CrossfadeOptions,
  EngineSource,
  EngineStatus,
  HandoffListener,
  LoadOptions,
  PlaybackEngine,
  StatusListener,
} from './types';

/** Which player library is in use. Published so the settings screen can show it. */
type EngineKind = 'expo' | 'native';

let activeKind: EngineKind = 'expo';
const kindSubscribers = new Set<() => void>();

function publishKind(next: EngineKind): void {
  if (activeKind === next) return;
  activeKind = next;
  for (const notify of kindSubscribers) notify();
}

function subscribeToActiveEngine(listener: () => void): () => void {
  kindSubscribers.add(listener);
  return () => {
    kindSubscribers.delete(listener);
  };
}

/**
 * The engine the whole app plays through.
 *
 * One object, so the store, the lock screen and the crossfade never have to know
 * which player library is underneath. It is built on first use rather than on
 * import, because the saved choice is only known once the store has rehydrated,
 * and changing the choice later swaps the engine behind this same binding —
 * which is what makes `expo-audio` a fallback and not just a second code path.
 */
class EngineHolder implements PlaybackEngine {
  private engine: PlaybackEngine | null = null;
  private statusListener: StatusListener | null = null;
  private handoffListener: HandoffListener | null = null;

  /** The player library actually in use. */
  get sourceKind(): EngineKind {
    return activeKind;
  }

  resolve(): PlaybackEngine {
    if (this.engine) return this.engine;

    const module = source === 'expo' ? null : nativePlayerModule();
    if (module) {
      publishKind('native');
      this.engine = new NativeAudioEngine(module);
    } else {
      if (source === 'native') {
        // Asked for by name and not there: worth a line in the error log, since
        // the setting is how the fallback is reached.
        useDiagnosticsStore.getState().addIssue(
          'audio',
          'Native playback was asked for, but this build has no native player.',
          nativePlayerLoadFailure() ?? 'The module is missing.',
        );
      }
      publishKind('expo');
      this.engine = new ExpoAudioEngine();
    }

    // The store registers its listeners once, at startup. A rebuilt engine has
    // to be given them again, or the app would go deaf to its own player.
    this.engine.setStatusListener(this.statusListener);
    this.engine.setHandoffListener(this.handoffListener);
    return this.engine;
  }

  /** Swaps the engine when the requested library is not the one running. */
  rebuildFor(next: EngineSource): void {
    if (!this.engine) return;
    const wantsNative = next !== 'expo' && nativePlayerModule() != null;
    if (wantsNative === (activeKind === 'native')) return;

    const previous = this.engine;
    this.engine = null;
    previous.unload();
    this.resolve();
  }

  /**
   * Drops the native engine and builds the expo one, keeping the listeners.
   *
   * Reached when the native player could not play something. It is a recovery
   * path, not a setting: the stored choice is untouched, so the next launch
   * tries the native player again.
   */
  useExpo(reason: string, detail?: string): void {
    if (activeKind !== 'native') return;
    const previous = this.engine;
    this.engine = null;
    source = 'expo';
    useDiagnosticsStore.getState().addIssue('audio', reason, detail ?? '');
    try {
      previous?.unload();
    } catch {
      // Already gone.
    }
    this.resolve();
  }

  setStatusListener(listener: StatusListener | null): void {
    this.statusListener = listener;
    this.engine?.setStatusListener(listener);
  }

  setHandoffListener(listener: HandoffListener | null): void {
    this.handoffListener = listener;
    this.engine?.setHandoffListener(listener);
  }

  configure(): Promise<void> {
    return this.resolve().configure();
  }

  async load(track: Track, options?: LoadOptions): Promise<void> {
    const engine = this.resolve();
    if (activeKind !== 'native') return engine.load(track, options);
    try {
      return await engine.load(track, options);
    } catch (error) {
      // A native player that cannot even open the source will not open the next
      // one either, so the rest of the run goes through expo-audio rather than
      // leaving every track silent.
      if (!fallBackToExpo('The native player could not open a track.', describeError(error).message)) {
        throw error;
      }
      return this.load(track, options);
    }
  }

  prepare(track: Track): void {
    this.resolve().prepare(track);
  }

  releaseStandby(): void {
    this.resolve().releaseStandby();
  }

  async crossfadeTo(track: Track, options: CrossfadeOptions): Promise<void> {
    const engine = this.resolve();
    if (activeKind !== 'native') return engine.crossfadeTo(track, options);
    try {
      return await engine.crossfadeTo(track, options);
    } catch (error) {
      if (!fallBackToExpo('The native player could not open a track.', describeError(error).message)) {
        throw error;
      }
      return this.crossfadeTo(track, options);
    }
  }

  updateLockScreenMetadata(track: Track): void {
    this.resolve().updateLockScreenMetadata(track);
  }

  fadeOutAndPause(durationMs?: number): Promise<void> {
    return this.resolve().fadeOutAndPause(durationMs);
  }

  setLevelGain(gain: number): void {
    this.resolve().setLevelGain(gain);
  }

  play(): void {
    this.resolve().play();
  }

  pause(): void {
    this.resolve().pause();
  }

  seek(seconds: number): Promise<void> {
    return this.resolve().seek(seconds);
  }

  replay(): void {
    this.resolve().replay();
  }

  unload(): void {
    // Deliberately does not build an engine that was never used.
    this.engine?.unload();
  }
}

/** The saved choice, until the store says otherwise. */
let source: EngineSource = 'auto';
const holder = new EngineHolder();

export const audioEngine: PlaybackEngine = holder;

/** Which player library is playing right now, for diagnostics and the settings screen. */
export function activeEngineSource(): EngineKind {
  return holder.sourceKind;
}

/** `activeEngineSource()` as a value React re-renders for. */
export function useActiveEngineSource(): EngineKind {
  return useSyncExternalStore(subscribeToActiveEngine, activeEngineSource, activeEngineSource);
}

/**
 * Switches to expo-audio after the native player failed to play a track.
 *
 * Returns true when the caller should retry, which happens once per run: after
 * the swap the active library is already expo-audio. An explicitly chosen
 * Native engine is left alone — that setting exists to test the native path,
 * and silently swapping it would hide the failure the listener is looking for.
 */
export function fallBackToExpo(reason: string, detail?: string): boolean {
  if (holder.sourceKind !== 'native' || source === 'native') return false;
  holder.useExpo(reason, detail);
  return true;
}

/**
 * Records the choice and, when the running engine is the other library, swaps
 * it. Called with the saved setting once the store rehydrates, and again if the
 * choice is changed in Settings.
 */
export function setEngineSource(next: EngineSource): void {
  if (next === source) return;
  source = next;
  holder.rebuildFor(next);
}
