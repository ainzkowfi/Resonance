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
  private fadePlayer: AudioPlayer | null = null;
  private fadeTrack: Track | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private fadeComplete: ((position: number) => void) | null = null;
  private fadeAbort: (() => void) | null = null;
  private fading = false;

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
    this.cancelCrossfade();

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

    try {
      const player = createAudioPlayer({ uri: track.uri }, { updateInterval: 250 });
      if (token !== this.loadToken) {
        player.remove();
        return;
      }
      this.player = player;

      this.bindStatus(player);

      this.updateLockScreenMetadata(track);

      if (options.startAt && options.startAt > 0) {
        await player.seekTo(options.startAt);
      }
      if (options.autoplay) player.play();
    } catch (error) {
      if (token !== this.loadToken) return;
      this.loadedId = null;
      this.player = null;
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
      if (this.fading && !status.playing) this.cancelCrossfade();
      if (status.didJustFinish && !this.handledFinish) {
        this.handledFinish = true;
      }
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

  /**
   * Starts `track` silently and crossfades both players over `seconds` once the
   * incoming player is actually running, then promotes it. Returns false when
   * nothing was started.
   */
  crossfade(
    track: Track,
    seconds: number,
    onComplete: (position: number) => void,
    onAbort: () => void,
  ): boolean {
    if (this.fading || !this.player || !track.uri || seconds <= 0) return false;
    let incoming: AudioPlayer;
    try {
      incoming = createAudioPlayer({ uri: track.uri }, { updateInterval: 250 });
      incoming.volume = 0;
      incoming.play();
    } catch (error) {
      console.warn('[audio] failed to start crossfade', error);
      return false;
    }
    const outgoing = this.player;
    const total = seconds * 1000;
    let startedAt: number | null = null;
    const waitUntil = Date.now() + 3000;
    this.fading = true;
    this.fadePlayer = incoming;
    this.fadeTrack = track;
    this.fadeComplete = onComplete;
    this.fadeAbort = onAbort;
    this.fadeTimer = setInterval(() => {
      // The incoming player needs a moment to prepare; ramping before it
      // produces silence would make the new track pop in at full volume.
      if (startedAt == null) {
        if (incoming.currentTime <= 0) {
          if (Date.now() > waitUntil) this.abortFade();
          return;
        }
        startedAt = Date.now();
      }
      const progress = Math.min(1, (Date.now() - startedAt) / total);
      try {
        outgoing.volume = Math.cos((progress * Math.PI) / 2);
        incoming.volume = Math.sin((progress * Math.PI) / 2);
      } catch {
        // A player was torn down underneath the fade.
      }
      if (progress >= 1) this.promote();
    }, 50);
    return true;
  }

  cancelCrossfade(): void {
    this.clearFadeTimer();
    const incoming = this.fadePlayer;
    this.fadePlayer = null;
    this.fadeTrack = null;
    this.fadeComplete = null;
    this.fadeAbort = null;
    this.fading = false;
    if (incoming) {
      try {
        incoming.pause();
        incoming.remove();
      } catch {
        // ignore
      }
    }
    if (this.player) {
      try {
        this.player.volume = 1;
      } catch {
        // ignore
      }
    }
  }

  private abortFade(): void {
    const abort = this.fadeAbort;
    this.cancelCrossfade();
    abort?.();
  }

  private promote(): void {
    this.clearFadeTimer();
    const incoming = this.fadePlayer;
    const track = this.fadeTrack;
    const done = this.fadeComplete;
    this.fadeAbort = null;
    this.fadePlayer = null;
    this.fadeTrack = null;
    this.fadeComplete = null;
    this.fading = false;
    if (!incoming || !track) return;
    const outgoing = this.player;
    this.subscription?.remove();
    this.subscription = null;
    if (outgoing) {
      try {
        outgoing.volume = 0;
        outgoing.pause();
        outgoing.remove();
      } catch {
        // ignore
      }
    }
    this.player = incoming;
    this.loadedId = track.id;
    this.handledFinish = false;
    incoming.volume = 1;
    this.bindStatus(incoming);
    this.updateLockScreenMetadata(track);
    done?.(incoming.currentTime);
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer) clearInterval(this.fadeTimer);
    this.fadeTimer = null;
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
    if (!this.player) return;
    try {
      await this.player.seekTo(Math.max(0, seconds));
    } catch {
      // ignore
    }
  }

  replay(): void {
    if (!this.player) return;
    void this.player.seekTo(0);
    this.player.play();
  }

  unload(): void {
    this.cancelCrossfade();
    this.loadToken++;
    this.subscription?.remove();
    this.subscription = null;
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
