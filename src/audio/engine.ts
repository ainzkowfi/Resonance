import {
  createAudioPlayer,
  requestNotificationPermissionsAsync,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';
import type { HandoffTiming } from '../lib/handoff';
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
  /** Native playback error, when the platform reports one. */
  error?: string | null;
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
  private handoffListener: ((timing: HandoffTiming) => void) | null = null;
  /** In-flight transition timing, cleared once the first audible status lands. */
  private handoff: {
    requestedAt: number;
    playRequestedAt: number;
    crossfade: boolean;
    preloaded: boolean;
  } | null = null;
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
  /** Hidden player holding the track that comes next, already opened. */
  private standby: AudioPlayer | null = null;
  private standbyId: string | null = null;

  setStatusListener(listener: StatusListener | null): void {
    this.listener = listener;
  }

  /** Reports how long a track change took to become audible. */
  setHandoffListener(listener: ((timing: HandoffTiming) => void) | null): void {
    this.handoffListener = listener;
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
      // Re-opening the track that is already loaded must still honour a start
      // position; otherwise a resume lands wherever the player happens to be.
      if (options.startAt && options.startAt > 0) void this.seek(options.startAt);
      this.applyPlayState(Boolean(options.autoplay));
      return;
    }

    // A preloaded player turns the handoff into a play() on a source that is
    // already open, instead of a create-and-load at the boundary.
    const standby = this.standbyId === track.id ? this.standby : null;
    if (standby) {
      this.standby = null;
      this.standbyId = null;
      this.promote(track, standby, options);
      return;
    }

    // Start the clock before teardown: releasing the old player is part of the
    // silence the listener hears between tracks.
    const requestedAt = Date.now();
    this.unload();
    const token = ++this.loadToken;
    this.loadedId = track.id;
    this.handledFinish = false;
    this.handoff = { requestedAt, playRequestedAt: 0, crossfade: false, preloaded: false };
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

      if (options.autoplay) {
        this.markPlayRequested();
        player.play();
      }
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
   * Opens a track in a hidden player so the next handoff is just a `play()`.
   *
   * Reuses the hidden player when the target changes, so queuing a different
   * next track costs a source swap rather than a new player.
   */
  prepare(track: Track): void {
    if (!track.uri) {
      this.releaseStandby();
      return;
    }
    if (this.standbyId === track.id && this.standby) return;

    if (this.standby) {
      try {
        this.standby.replace({ uri: track.uri });
        this.standby.volume = 0;
        this.standbyId = track.id;
        return;
      } catch {
        this.releaseStandby();
      }
    }

    try {
      const player = createAudioPlayer({ uri: track.uri }, { updateInterval: 250 });
      player.volume = 0;
      this.standby = player;
      this.standbyId = track.id;
    } catch (error) {
      console.warn('[audio] failed to preload track', error);
    }
  }

  /** Drops the preloaded player, if any. */
  releaseStandby(): void {
    const player = this.standby;
    this.standby = null;
    this.standbyId = null;
    if (!player) return;
    try {
      player.pause();
      player.remove();
    } catch {
      // Already gone.
    }
  }

  /**
   * Swaps in a player that was opened ahead of time.
   *
   * Everything that made the old player unique is retired here, but the new one
   * is not created or loaded — that already happened.
   */
  private promote(
    track: Track,
    player: AudioPlayer,
    options: { autoplay?: boolean; startAt?: number },
  ): void {
    const requestedAt = Date.now();
    this.loadToken++;
    this.releaseOutgoing();
    this.subscription?.remove();
    this.subscription = null;

    const previous = this.player;
    this.player = player;
    this.loadedId = track.id;
    this.handledFinish = false;
    this.isLoaded = false;
    this.isBuffering = false;
    this.pendingSeek = options.startAt && options.startAt > 0 ? options.startAt : null;
    this.fadeGain = 1;
    this.handoff = { requestedAt, playRequestedAt: 0, crossfade: false, preloaded: true };
    this.applyGain();

    this.bindStatus(player);
    this.updateLockScreenMetadata(track);

    if (previous) {
      try {
        previous.pause();
        previous.remove();
      } catch {
        // Already gone.
      }
    }

    if (options.autoplay) {
      this.markPlayRequested();
      player.play();
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

    // Blend from the preloaded player when it is the right track.
    const standby = this.standbyId === track.id ? this.standby : null;
    if (standby) {
      this.standby = null;
      this.standbyId = null;
    } else {
      this.releaseStandby();
    }
    this.handoff = {
      requestedAt: Date.now(),
      playRequestedAt: 0,
      crossfade: true,
      preloaded: standby != null,
    };

    let incoming: AudioPlayer | null = null;
    try {
      incoming = standby ?? createAudioPlayer({ uri: track.uri }, { updateInterval: 250 });
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
      if (options.autoplay !== false) {
        this.markPlayRequested();
        incoming.play();
      }

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

  /**
   * Puts the track on the lock screen and in the media notification.
   *
   * The controls are limited to what a single player can honour. Skip forward
   * and back seek within the track, which the platform does itself; next and
   * previous only exist for a native playlist, so enabling them here would draw
   * buttons that do nothing.
   */
  updateLockScreenMetadata(track: Track): void {
    if (!this.player) return;
    try {
      this.player.setActiveForLockScreen(
        true,
        {
          title: track.title,
          artist: track.artist,
          albumTitle: track.album,
          artworkUrl: track.artwork,
        },
        {
          showSeekForward: true,
          showSeekBackward: true,
          seekForwardIntervalSeconds: 30,
          seekBackwardIntervalSeconds: 15,
          isLiveStream: false,
        },
      );
    } catch {
      // Web and some Android builds have no lock screen surface.
    }
  }

  /**
   * Fades to silence, then pauses, leaving the position where it was.
   *
   * Used when playback has to yield to something else. The platform often cuts
   * the audio before the app learns of it, so this is the clean version of that
   * hand-off: where the player is still running — a transient focus change, or
   * an Android build that only ducked — the stop is a ramp instead of a cut.
   */
  async fadeOutAndPause(durationMs = 220): Promise<void> {
    const player = this.player;
    if (!player) return;

    // A crossfade in flight would leave the outgoing player at whatever volume
    // it had reached, so it is released rather than just stopped.
    this.releaseOutgoing();
    const step = 40;
    const total = Math.max(step, durationMs);
    const started = Date.now();

    for (;;) {
      const progress = Math.min(1, (Date.now() - started) / total);
      this.fadeGain = 1 - progress;
      this.applyGain();
      if (progress >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, step));
    }

    this.applyPlayState(false);
    // Restored so the next play starts at the level the track is meant to have.
    this.fadeGain = 1;
    this.applyGain();
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
      if (this.handoff && status.playing && status.currentTime > 0) {
        const handoff = this.handoff;
        this.handoff = null;
        this.handoffListener?.({
          requestedAt: handoff.requestedAt,
          playRequestedAt: handoff.playRequestedAt,
          firstAudibleAt: Date.now(),
          currentTime: status.currentTime,
          crossfade: handoff.crossfade,
          preloaded: handoff.preloaded,
        });
      }
      // Edge-triggered on purpose. A finished player keeps reporting
      // `didJustFinish` on every status tick, and the queue reads that flag as
      // "advance" — four times a second. On the last track with repeat off that
      // became a play/pause loop the user could not get out of.
      const justFinished = Boolean(status.didJustFinish) && !this.handledFinish;
      if (justFinished) this.handledFinish = true;
      this.isLoaded = status.isLoaded;
      this.isBuffering = status.isBuffering;
      if (this.isLoaded && !this.isBuffering) void this.flushSeek();
      this.listener?.({
        currentTime: status.currentTime ?? 0,
        duration: status.duration ?? 0,
        playing: status.playing,
        didJustFinish: justFinished,
        isLoaded: status.isLoaded,
        isBuffering: status.isBuffering,
        // A source the platform cannot decode often fails here rather than at
        // `createAudioPlayer`, so this is the only signal for those files.
        error: status.error ?? null,
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
      // A seek re-arms the end of the track: repeat-one loops again, and a
      // track seeked back is allowed to advance when it reaches the end.
      this.handledFinish = false;
    } catch {
      // ignore
    } finally {
      this.seeking = false;
    }
    if (this.pendingSeek != null) await this.flushSeek();
  }

  replay(): void {
    if (!this.player) return;
    // Re-armed even when the seek is deferred: a pending seek is applied on the
    // next loaded status, and the finish flag has to be clear by then.
    this.handledFinish = false;
    void this.seek(0);
    this.play();
  }

  private markPlayRequested(): void {
    if (this.handoff) this.handoff.playRequestedAt = Date.now();
  }

  unload(): void {
    this.loadToken++;
    this.handoff = null;
    this.releaseOutgoing();
    this.releaseStandby();
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
