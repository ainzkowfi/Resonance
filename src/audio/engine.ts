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
 * store — it pushes status updates through a listener the store registers — so
 * there is no module cycle.
 *
 * Output volume is a small gain bus: the leveling gain for the current track
 * multiplied by a fade gain. Anything that wants to change loudness sets one of
 * those, never `player.volume`, so leveling and crossfading cannot fight.
 *
 * During a crossfade a second player exists briefly. It is never bound to the
 * store or the lock screen: the incoming track is promoted immediately and the
 * outgoing one is only ramped down and released.
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

/** How often the fade ramp updates. 50 ms is smooth without being busy. */
const FADE_STEP_MS = 50;

function unit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

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

  /** Leveling gain for the loaded track, 0..1. */
  private levelGain = 1;
  /** Fade gain layered on top of the leveling gain, 0..1. */
  private fadeGain = 1;
  /** Player being faded out; removed when the ramp finishes. */
  private outgoing: AudioPlayer | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;

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
      this.applyGain();

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

  /**
   * Promotes `track` and blends it over the track that is playing.
   *
   * Falls back to a hard `load` when nothing is playing — fading out silence is
   * pointless — or when the requested length is not usable.
   */
  async crossfadeTo(
    track: Track,
    options: { autoplay?: boolean; startAt?: number; seconds: number; gain?: number },
  ): Promise<void> {
    await this.configure();

    const seconds = options.seconds;
    const outgoing = this.player;

    if (!track.uri) {
      this.unload();
      return;
    }

    if (!outgoing || !outgoing.playing || !Number.isFinite(seconds) || seconds <= 0) {
      if (options.gain != null) this.setLevelGain(options.gain);
      await this.load(track, options);
      return;
    }

    const token = ++this.loadToken;
    // A second fade (double tap on next) must not orphan the first outgoing
    // player at whatever volume it had reached.
    this.releaseOutgoing();
    // Capture before the leveling gain changes: this is the outgoing fade's
    // starting volume.
    const outgoingStart = unit(outgoing.volume ?? this.levelGain);

    this.subscription?.remove();
    this.subscription = null;

    let incoming: AudioPlayer | null = null;
    try {
      incoming = createAudioPlayer({ uri: track.uri }, { updateInterval: 250 });
      if (token !== this.loadToken) {
        incoming.remove();
        return;
      }

      this.player = incoming;
      this.loadedId = track.id;
      this.handledFinish = false;
      this.isLoaded = false;
      this.isBuffering = false;
      this.pendingSeek = null;
      this.outgoing = outgoing;
      if (options.gain != null) this.levelGain = unit(options.gain);
      this.fadeGain = 0;
      this.applyGain();

      this.bindStatus(incoming);
      this.updateLockScreenMetadata(track);
      if (options.autoplay !== false) incoming.play();

      this.startFade(outgoing, outgoingStart, seconds);
    } catch (error) {
      if (incoming) {
        try {
          incoming.remove();
        } catch {
          // ignore
        }
      }
      if (token !== this.loadToken) return;
      // Never leave the outgoing track playing with no handle on it.
      this.releaseOutgoing();
      this.player = null;
      this.loadedId = null;
      console.warn('[audio] failed to crossfade track', error);
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

  /** Leveling gain for the loaded track; multiplied with any active fade. */
  setLevelGain(gain: number): void {
    this.levelGain = unit(gain);
    this.applyGain();
  }

  private applyGain(): void {
    const player = this.player;
    if (!player) return;
    try {
      player.volume = unit(this.levelGain * this.fadeGain);
    } catch {
      // The player may already have been released.
    }
  }

  /** Routes one player's status updates into the store listener. */
  private bindStatus(player: AudioPlayer): void {
    this.subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (!status) return;
      // A released player can still emit a queued event; ignoring it is what
      // keeps a crossfade from advancing the queue twice.
      if (this.player !== player) return;
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
    // Both players during a fade: pausing must silence the outgoing track too.
    for (const player of [this.player, this.outgoing]) {
      if (!player) continue;
      try {
        if (shouldPlay) player.play();
        else player.pause();
      } catch {
        // The status listener will reconcile on the next tick.
      }
    }
  }

  private startFade(outgoing: AudioPlayer, startVolume: number, seconds: number): void {
    const started = Date.now();
    const total = Math.max(FADE_STEP_MS, seconds * 1000);

    this.fadeTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / total);
      this.fadeGain = progress;
      this.applyGain();
      try {
        outgoing.volume = unit(startVolume * (1 - progress));
      } catch {
        // Released early; the next tick finishes the ramp.
      }
      if (progress >= 1) this.finishFade();
    }, FADE_STEP_MS);
  }

  private finishFade(): void {
    this.releaseOutgoing();
    this.applyGain();
  }

  private clearFade(): void {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  /** Stops the ramp and removes the outgoing player. */
  private releaseOutgoing(): void {
    this.clearFade();
    this.fadeGain = 1;
    const outgoing = this.outgoing;
    this.outgoing = null;
    if (!outgoing) return;
    try {
      outgoing.pause();
      outgoing.remove();
    } catch {
      // Already gone.
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
    this.releaseOutgoing();
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
