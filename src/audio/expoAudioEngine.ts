import {
  createAudioPlayer,
  requestNotificationPermissionsAsync,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';

import type { EnginePlayer, LockScreenOptions, PlayerBackend } from './backend';
import { BasePlaybackEngine } from './engineBase';
import type { EngineStatus } from './types';

/**
 * Playback on `expo-audio`.
 *
 * Only the player primitives live here; the queue handoff, the gain bus and the
 * crossfade are in `engineBase.ts` and are shared with the native backend, so
 * the two can be compared by their primitives rather than by their behaviour.
 */

/** Normalised, so nothing downstream has to know which keys expo-audio left out. */
function toStatus(status: AudioStatus): EngineStatus {
  return {
    currentTime: status.currentTime ?? 0,
    duration: status.duration ?? 0,
    playing: Boolean(status.playing),
    didJustFinish: Boolean(status.didJustFinish),
    isLoaded: Boolean(status.isLoaded),
    isBuffering: Boolean(status.isBuffering),
    error: status.error ?? null,
  };
}

class ExpoPlayer implements EnginePlayer {
  constructor(
    private readonly player: AudioPlayer,
    private readonly onRelease: () => void,
  ) {}

  play(): void {
    try {
      this.player.play();
    } catch {
      // A released player; the next status reconciles.
    }
  }

  pause(): void {
    try {
      this.player.pause();
    } catch {
      // Already gone.
    }
  }

  async seek(seconds: number): Promise<void> {
    await this.player.seekTo(seconds);
  }

  setVolume(volume: number): void {
    try {
      this.player.volume = volume;
    } catch {
      // Already gone.
    }
  }

  release(): void {
    this.onRelease();
    try {
      this.player.pause();
      this.player.remove();
    } catch {
      // Already gone.
    }
  }

  async replace(uri: string): Promise<void> {
    // Throws when the new source cannot be opened, which the engine turns into
    // a fresh player on the next load.
    this.player.replace({ uri });
  }

  setLockScreen(options: LockScreenOptions | null): void {
    if (!options) {
      this.player.setActiveForLockScreen(false);
      return;
    }
    this.player.setActiveForLockScreen(
      true,
      {
        title: options.title,
        artist: options.artist,
        albumTitle: options.album,
        artworkUrl: options.artwork,
      },
      {
        showSeekForward: options.showSeekForward,
        showSeekBackward: options.showSeekBackward,
        seekForwardIntervalSeconds: options.seekForwardIntervalSeconds,
        seekBackwardIntervalSeconds: options.seekBackwardIntervalSeconds,
        isLiveStream: false,
      },
    );
  }
}

class ExpoBackend implements PlayerBackend {
  private listener: ((player: EnginePlayer, status: EngineStatus) => void) | null = null;
  private readonly subscriptions = new Map<EnginePlayer, { remove: () => void }>();

  async configure(): Promise<void> {
    try {
      // `doNotMix` is required for lock screen controls to bind to this player.
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'doNotMix',
      });
    } catch (error) {
      console.warn('[audio] failed to configure audio mode', error);
    }
    try {
      // Android needs POST_NOTIFICATIONS for the notification-shade controls.
      await requestNotificationPermissionsAsync();
    } catch {
      // Not fatal: in-app playback still works.
    }
  }

  async open(uri: string): Promise<EnginePlayer> {
    const audio = createAudioPlayer({ uri }, { updateInterval: 250 });
    const player = new ExpoPlayer(audio, () => {
      this.subscriptions.get(player)?.remove();
      this.subscriptions.delete(player);
    });
    const subscription = audio.addListener('playbackStatusUpdate', (status) => {
      if (!status) return;
      this.listener?.(player, toStatus(status));
    });
    this.subscriptions.set(player, subscription);
    return player;
  }

  subscribe(listener: (player: EnginePlayer, status: EngineStatus) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
      for (const subscription of this.subscriptions.values()) subscription.remove();
      this.subscriptions.clear();
    };
  }
}

export class ExpoAudioEngine extends BasePlaybackEngine {
  constructor() {
    super(new ExpoBackend());
  }
}
