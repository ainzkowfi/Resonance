import { requireNativeModule } from 'expo';

import { toPath } from '../media/paths';
import type { EnginePlayer, LockScreenOptions, PlayerBackend } from './backend';
import { BasePlaybackEngine } from './engineBase';
import type { EngineStatus } from './types';

/**
 * Playback on the native module (`src/native/ResonancePlayerModule.kt`).
 *
 * `MediaPlayer` reports nothing on its own, so the module ticks status for
 * every open player four times a second and this maps those reports onto the
 * same `EngineStatus` expo-audio produces. Handles are minted here and never
 * inspected by the native side; they exist so a report can be attributed to the
 * player it came from.
 */

interface StatusPayload {
  handle: string;
  currentTime: number;
  duration: number;
  playing: boolean;
  didJustFinish: boolean;
  isLoaded: boolean;
  isBuffering: boolean;
  error?: string | null;
}

export interface NativePlayerModule {
  configure: () => Promise<boolean>;
  create: (handle: string, path: string) => Promise<boolean>;
  replace: (handle: string, path: string) => Promise<boolean>;
  seek: (handle: string, seconds: number) => Promise<boolean>;
  play: (handle: string) => void;
  pause: (handle: string) => void;
  setVolume: (handle: string, volume: number) => void;
  release: (handle: string) => void;
  setLockScreen: (
    handle: string,
    title: string,
    artist: string,
    album: string | null,
    artwork: string | null,
    forwardSeconds: number,
    backwardSeconds: number,
  ) => void;
  addListener: (
    event: 'onPlaybackStatus',
    listener: (payload: StatusPayload) => void,
  ) => { remove: () => void };
}

let attempted = false;
let native: NativePlayerModule | null = null;
let failure: string | undefined;

/**
 * The native module, or null when this binary does not carry it.
 *
 * The require is synchronous and cached: which engine to use has to be decided
 * before the first status tick, and a binary without the module — Expo Go, web,
 * an older dev client — has to fall back rather than throw on import.
 */
export function nativePlayerModule(): NativePlayerModule | null {
  if (!attempted) {
    attempted = true;
    try {
      native = requireNativeModule('ResonancePlayerModule') as NativePlayerModule;
    } catch (error) {
      native = null;
      failure = error instanceof Error ? error.message : String(error);
    }
  }
  return native;
}

/** Why the native player is not in this build, when it is not. */
export function nativePlayerLoadFailure(): string | undefined {
  return failure;
}

/**
 * The native decoder wants plain filesystem paths, but a library picked through
 * the system folder picker is a `content://` URI, which `MediaPlayer` opens
 * through the content resolver — and decoding the percent-escapes out of one
 * would corrupt it.
 */
function nativeSource(uri: string): string {
  return uri.startsWith('content://') ? uri : toPath(uri);
}

class NativePlayer implements EnginePlayer {
  constructor(
    private readonly handle: string,
    private readonly module: NativePlayerModule,
    private readonly onRelease: (handle: string) => void,
  ) {}

  play(): void {
    this.module.play(this.handle);
  }

  pause(): void {
    this.module.pause(this.handle);
  }

  async seek(seconds: number): Promise<void> {
    await this.module.seek(this.handle, seconds);
  }

  setVolume(volume: number): void {
    this.module.setVolume(this.handle, volume);
  }

  release(): void {
    this.onRelease(this.handle);
    this.module.release(this.handle);
  }

  async replace(uri: string): Promise<void> {
    await this.module.replace(this.handle, nativeSource(uri));
  }

  setLockScreen(options: LockScreenOptions | null): void {
    if (!options) return;
    this.module.setLockScreen(
      this.handle,
      options.title,
      options.artist,
      options.album ?? null,
      options.artwork ? nativeSource(options.artwork) : null,
      options.seekForwardIntervalSeconds,
      options.seekBackwardIntervalSeconds,
    );
  }
}

class NativeBackend implements PlayerBackend {
  private listener: ((player: EnginePlayer, status: EngineStatus) => void) | null = null;
  private readonly players = new Map<string, NativePlayer>();
  private subscription: { remove: () => void } | null = null;
  private sequence = 0;

  constructor(private readonly module: NativePlayerModule) {}

  async configure(): Promise<void> {
    await this.module.configure();
    this.subscription ??= this.module.addListener('onPlaybackStatus', (payload) => {
      if (!payload) return;
      const player = this.players.get(payload.handle);
      // A player that has been released can still have a tick in flight.
      if (!player) return;
      this.listener?.(player, {
        currentTime: payload.currentTime ?? 0,
        duration: payload.duration ?? 0,
        playing: Boolean(payload.playing),
        didJustFinish: Boolean(payload.didJustFinish),
        isLoaded: Boolean(payload.isLoaded),
        isBuffering: Boolean(payload.isBuffering),
        error: payload.error ?? null,
      });
    });
  }

  async open(uri: string): Promise<EnginePlayer> {
    const handle = `p${++this.sequence}`;
    const player = new NativePlayer(handle, this.module, (released) =>
      this.players.delete(released),
    );
    // Registered before the source is opened, so a status that arrives while
    // the decoder is still starting is not dropped.
    this.players.set(handle, player);
    try {
      await this.module.create(handle, nativeSource(uri));
    } catch (error) {
      this.players.delete(handle);
      throw error;
    }
    return player;
  }

  subscribe(listener: (player: EnginePlayer, status: EngineStatus) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
      this.subscription?.remove();
      this.subscription = null;
    };
  }
}

export class NativeAudioEngine extends BasePlaybackEngine {
  constructor(module: NativePlayerModule) {
    super(new NativeBackend(module));
  }
}
