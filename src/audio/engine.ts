import {
  createAudioPlayer,
  requestNotificationPermissionsAsync,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';
import type { Track } from '../types/track';

/**
 * The playback engine.
 *
 * A single `expo-audio` player instance owns one track at a time; the queue
 * lives in the store, which drives this engine. The engine never imports the
 * store — it pushes status updates through a listener the store registers —
 * so there is no module cycle.
 */

export interface EngineStatus {
  currentTime: number;
  duration: number;
  playing: boolean;
  didJustFinish: boolean;
  isLoaded: boolean;
  isBuffering: boolean;
}

type StatusListener = (status: EngineStatus) => void;

class AudioEngine {
  private player: AudioPlayer | null = null;
  private subscription: { remove: () => void } | null = null;
  private listener: StatusListener | null = null;
  private loadedId: string | null = null;
  private configured = false;
  /** Monotonic token: an in-flight load that is superseded bails out. */
  private loadToken = 0;
  private handledFinish = false;
  private isLoaded = false;
  private isBuffering = false;
  private pendingSeek: number | null = null;
  private seeking = false;

  setStatusListener(listener: StatusListener | null): void {
    this.listener = listener;
  }

  async configure(): Promise<void> {
    if (this.configured) return;
    this.configured = true;
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

  async load(
    track: Track,
    options: { autoplay?: boolean; startAt?: number } = {},
  ): Promise<void> {
    await this.configure();

    if (!track.uri) {
      this.unload();
      return;
    }

    if (this.loadedId === track.id && this.player) {
      this.applyPlayState(Boolean(options.autoplay));
      return;
    }

    this.unload();
    const token = ++this.loadToken;
    this.loadedId = track.id;
    this.handledFinish = false;
    let player: AudioPlayer | null = null;

    try {
      player = createAudioPlayer({ uri: track.uri }, { updateInterval: 250 });
      if (token !== this.loadToken) {
        player.remove();
        return;
      }
      this.player = player;

      // Seeking before the source is loaded can take the native player down.
      // Keep the requested position until a loaded status arrives.
      if (options.startAt && options.startAt > 0) {
        this.pendingSeek = options.startAt;
      }

      this.bindStatus(player);

      this.updateLockScreenMetadata(track);

      if (options.autoplay) player.play();
    } catch (error) {
      if (player) {
        try {
          player.remove();
        } catch {
          // ignore
        }
      }
      if (token !== this.loadToken) return;
      if (this.player === player) {
        this.subscription?.remove();
        this.subscription = null;
        this.player = null;
      }
      this.loadedId = null;
      this.pendingSeek = null;
      console.warn('[audio] failed to load track', error);
      throw error;
    }
  }

  updateLockScreenMetadata(track: Track): void {
    if (!this.player) return;
    try {
      this.player.setActiveForLockScreen(true, {
        title: track.title,
        artist: track.artist,
        albumTitle: track.album,
        artworkUrl: track.artwork,
      });
    } catch {
      // Web and some Android builds have no lock screen surface.
    }
  }

  /** Routes one player's status updates into the store listener. */
  private bindStatus(player: AudioPlayer): void {
    this.subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (!status) return;
      if (status.didJustFinish && !this.handledFinish) {
        this.handledFinish = true;
      }
      this.isLoaded = status.isLoaded;
      this.isBuffering = status.isBuffering;
      if (this.isLoaded && !this.isBuffering) void this.flushSeek();
      this.listener?.({
        currentTime: status.currentTime ?? 0,
        duration: status.duration ?? 0,
        playing: status.playing,
        didJustFinish: status.didJustFinish,
        isLoaded: status.isLoaded,
        isBuffering: status.isBuffering,
      });
    });
  }

  private applyPlayState(shouldPlay: boolean): void {
    if (!this.player) return;
    try {
      if (shouldPlay) this.player.play();
      else this.player.pause();
    } catch {
      // The status listener will reconcile on the next tick.
    }
  }

  play(): void {
    this.applyPlayState(true);
  }

  pause(): void {
    this.applyPlayState(false);
  }

  async seek(seconds: number): Promise<void> {
    if (!this.player || !Number.isFinite(seconds)) return;
    // Keep only the newest target. A seek issued while the source is loading
    // or buffering is applied as soon as the player reports that it is ready.
    this.pendingSeek = Math.max(0, seconds);
    await this.flushSeek();
  }

  private async flushSeek(): Promise<void> {
    if (this.seeking || this.pendingSeek == null) return;
    const player = this.player;
    if (!player || !this.isLoaded || this.isBuffering) return;

    const target = this.pendingSeek;
    this.pendingSeek = null;
    this.seeking = true;
    try {
      await player.seekTo(target);
    } catch {
      // ignore
    } finally {
      this.seeking = false;
    }
    if (this.pendingSeek != null) await this.flushSeek();
  }

  replay(): void {
    if (!this.player) return;
    void this.seek(0);
    this.play();
  }

  unload(): void {
    this.loadToken++;
    this.subscription?.remove();
    this.subscription = null;
    this.isLoaded = false;
    this.isBuffering = false;
    this.pendingSeek = null;
    if (this.player) {
      try {
        this.player.pause();
        this.player.remove();
      } catch {
        // ignore
      }
    }
    this.player = null;
    this.loadedId = null;
  }
}

export const audioEngine = new AudioEngine();
