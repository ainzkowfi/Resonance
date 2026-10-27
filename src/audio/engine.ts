import { useDiagnosticsStore } from '../store/diagnostics';
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
  private kind: 'expo' | 'native' = 'expo';

  /** The player library actually in use. */
  get sourceKind(): 'expo' | 'native' {
    return this.kind;
  }

  resolve(): PlaybackEngine {
    if (this.engine) return this.engine;

    const module = source === 'expo' ? null : nativePlayerModule();
    if (module) {
      this.kind = 'native';
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
      this.kind = 'expo';
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
    if (wantsNative === (this.kind === 'native')) return;

    const previous = this.engine;
    this.engine = null;
    previous.unload();
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

  load(track: Track, options?: LoadOptions): Promise<void> {
    return this.resolve().load(track, options);
  }

  prepare(track: Track): void {
    this.resolve().prepare(track);
  }

  releaseStandby(): void {
    this.resolve().releaseStandby();
  }

  crossfadeTo(track: Track, options: CrossfadeOptions): Promise<void> {
    return this.resolve().crossfadeTo(track, options);
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

/** Which player library is playing right now, for the settings screen. */
export function activeEngineSource(): 'expo' | 'native' {
  return holder.sourceKind;
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
