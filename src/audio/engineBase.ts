import type { Track } from '../types/track';
import type { EnginePlayer, PlayerBackend } from './backend';
import type {
  CrossfadeOptions,
  EngineStatus,
  HandoffListener,
  LoadOptions,
  PlaybackEngine,
  StatusListener,
} from './types';

/**
 * The playback engine, independent of whatever plays the sound.
 *
 * A single main player owns one track at a time; the queue lives in the store,
 * which drives this engine. The engine never imports the store — it pushes
 * status updates through a listener the store registers — so there is no module
 * cycle.
 *
 * Output volume is a small gain bus: the leveling gain for the current track
 * multiplied by a fade gain. Anything that wants to change loudness sets one of
 * those, never a player's volume directly, so leveling and crossfading cannot
 * fight.
 *
 * During a crossfade a second player exists briefly. It is never bound to the
 * store or the lock screen: the incoming track is promoted immediately and the
 * outgoing one is only ramped down and released.
 *
 * Everything here that is about timing — when a handoff became audible, when to
 * stop waiting for a load, which seek is the newest — is deliberately in one
 * place, so a second player library cannot quietly behave differently.
 */

/** How often the fade ramp updates. 50 ms is smooth without being busy. */
const FADE_STEP_MS = 50;

/** Lock screen seek buttons, as the app has always drawn them. */
const SEEK_FORWARD_SECONDS = 30;
const SEEK_BACKWARD_SECONDS = 15;

function unit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export abstract class BasePlaybackEngine implements PlaybackEngine {
  protected constructor(private readonly backend: PlayerBackend) {}

  private main: EnginePlayer | null = null;
  private listener: StatusListener | null = null;
  private handoffListener: HandoffListener | null = null;
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
  /** Last reported playing state of the main player. */
  private playing = false;
  private pendingSeek: number | null = null;
  private seeking = false;

  /** Leveling gain for the loaded track, 0..1. */
  private levelGain = 1;
  /** Fade gain layered on top of the leveling gain, 0..1. */
  private fadeGain = 1;
  /** Player being faded out; released when the ramp finishes. */
  private outgoing: EnginePlayer | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  /** Hidden player holding the track that comes next, already opened. */
  private standby: EnginePlayer | null = null;
  private standbyId: string | null = null;
  /** Discards a preload whose source is still opening when it is superseded. */
  private standbyToken = 0;
  private unsubscribe: (() => void) | null = null;

  setStatusListener(listener: StatusListener | null): void {
    this.listener = listener;
  }

  /** Reports how long a track change took to become audible. */
  setHandoffListener(listener: HandoffListener | null): void {
    this.handoffListener = listener;
  }

  async configure(): Promise<void> {
    if (this.configured) return;
    this.configured = true;
    // Subscribed before the first player exists, so a status that arrives
    // during a load is not dropped.
    this.unsubscribe ??= this.backend.subscribe((player, status) => this.onStatus(player, status));
    await this.backend.configure();
  }

  async load(track: Track, options: LoadOptions = {}): Promise<void> {
    await this.configure();

    if (!track.uri) {
      this.unload();
      return;
    }

    if (this.loadedId === track.id && this.main) {
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
    let player: EnginePlayer | null = null;

    try {
      player = await this.backend.open(track.uri);
      if (token !== this.loadToken) {
        player.release();
        return;
      }
      this.main = player;

      // Seeking before the source is loaded can take the native player down.
      // Keep the requested position until a loaded status arrives.
      if (options.startAt && options.startAt > 0) {
        this.pendingSeek = options.startAt;
      }

      this.applyGain();
      this.applyLockScreen(player, track);

      if (options.autoplay) {
        this.markPlayRequested();
        player.play();
      }
    } catch (error) {
      if (player) {
        try {
          player.release();
        } catch {
          // ignore
        }
      }
      if (token !== this.loadToken) return;
      if (this.main === player) this.main = null;
      this.loadedId = null;
      this.pendingSeek = null;
      console.warn('[audio] failed to load track', error);
      throw error;
    }
  }

  /**
   * Opens a track in a hidden player so the next handoff is just a `play()`.
   *
   * The previous standby is dropped rather than re-pointed at the new track:
   * a source swap and a fresh player cost the same on the player libraries this
   * runs on, and only one of the two can be interrupted halfway.
   */
  prepare(track: Track): void {
    if (!track.uri) {
      this.releaseStandby();
      return;
    }
    if (this.standbyId === track.id && this.standby) return;

    this.releaseStandby();
    const token = ++this.standbyToken;
    void this.openStandby(track, token);
  }

  private async openStandby(track: Track, token: number): Promise<void> {
    try {
      const player = await this.backend.open(track.uri);
      player.setVolume(0);
      if (token !== this.standbyToken) {
        // Superseded while the source was opening.
        player.release();
        return;
      }
      this.standby = player;
      this.standbyId = track.id;
    } catch (error) {
      console.warn('[audio] failed to preload track', error);
    }
  }

  /** Drops the preloaded player, if any. */
  releaseStandby(): void {
    this.standbyToken++;
    const player = this.standby;
    this.standby = null;
    this.standbyId = null;
    if (!player) return;
    try {
      player.pause();
      player.release();
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
  private promote(track: Track, player: EnginePlayer, options: LoadOptions): void {
    const requestedAt = Date.now();
    this.loadToken++;
    this.standbyToken++;
    this.releaseOutgoing();

    const previous = this.main;
    this.main = player;
    this.loadedId = track.id;
    this.handledFinish = false;
    this.isLoaded = false;
    this.isBuffering = false;
    this.playing = false;
    this.pendingSeek = options.startAt && options.startAt > 0 ? options.startAt : null;
    this.fadeGain = 1;
    this.handoff = { requestedAt, playRequestedAt: 0, crossfade: false, preloaded: true };
    this.applyGain();
    this.applyLockScreen(player, track);

    if (previous) {
      try {
        previous.pause();
        previous.release();
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
  async crossfadeTo(track: Track, options: CrossfadeOptions): Promise<void> {
    await this.configure();

    const seconds = options.seconds;
    const outgoing = this.main;

    if (!track.uri) {
      this.unload();
      return;
    }

    if (!outgoing || !this.playing || !Number.isFinite(seconds) || seconds <= 0) {
      if (options.gain != null) this.setLevelGain(options.gain);
      await this.load(track, options);
      return;
    }

    const token = ++this.loadToken;
    // A second fade (double tap on next) must not orphan the first outgoing
    // player at whatever volume it had reached.
    this.releaseOutgoing();
    // Captured before the leveling gain changes: this is the outgoing fade's
    // starting volume, which is the gain bus the last applyGain left it at.
    const outgoingStart = unit(this.levelGain * this.fadeGain);

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

    let incoming: EnginePlayer | null = null;
    try {
      incoming = standby ?? (await this.backend.open(track.uri));
      if (token !== this.loadToken) {
        incoming.release();
        return;
      }

      this.main = incoming;
      this.loadedId = track.id;
      this.handledFinish = false;
      this.isLoaded = false;
      this.isBuffering = false;
      this.playing = false;
      this.pendingSeek = null;
      this.outgoing = outgoing;
      if (options.gain != null) this.levelGain = unit(options.gain);
      this.fadeGain = 0;
      this.applyGain();

      this.applyLockScreen(incoming, track);
      if (options.autoplay !== false) {
        this.markPlayRequested();
        incoming.play();
      }

      this.startFade(outgoing, outgoingStart, seconds);
    } catch (error) {
      if (incoming) {
        try {
          incoming.release();
        } catch {
          // ignore
        }
      }
      if (token !== this.loadToken) return;
      // Never leave the outgoing track playing with no handle on it.
      this.releaseOutgoing();
      this.main = null;
      this.loadedId = null;
      console.warn('[audio] failed to crossfade track', error);
      throw error;
    }
  }

  /**
   * Puts the track on the lock screen and in the media notification.
   *
   * The controls are limited to what a single player can honour. Skip forward
   * and back seek within the track; next and previous only exist for a native
   * playlist, so enabling them here would draw buttons that do nothing.
   */
  updateLockScreenMetadata(track: Track): void {
    this.applyLockScreen(this.main, track);
  }

  private applyLockScreen(player: EnginePlayer | null, track: Track): void {
    if (!player) return;
    try {
      player.setLockScreen({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: track.artwork,
        showSeekForward: true,
        showSeekBackward: true,
        seekForwardIntervalSeconds: SEEK_FORWARD_SECONDS,
        seekBackwardIntervalSeconds: SEEK_BACKWARD_SECONDS,
      });
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
    const player = this.main;
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
    const player = this.main;
    if (!player) return;
    try {
      player.setVolume(unit(this.levelGain * this.fadeGain));
    } catch {
      // The player may already have been released.
    }
  }

  /** Routes one player's status updates into the store listener. */
  private onStatus(player: EnginePlayer, status: EngineStatus): void {
    if (!status) return;
    // A released player can still emit a queued event; ignoring it is what
    // keeps a crossfade from advancing the queue twice.
    if (this.main !== player) return;
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
    this.playing = status.playing;
    if (this.isLoaded && !this.isBuffering) void this.flushSeek();
    this.listener?.({
      currentTime: status.currentTime ?? 0,
      duration: status.duration ?? 0,
      playing: status.playing,
      didJustFinish: justFinished,
      isLoaded: status.isLoaded,
      isBuffering: status.isBuffering,
      // A source the platform cannot decode often fails here rather than at
      // `load`, so this is the only signal for those files.
      error: status.error ?? null,
    });
  }

  private applyPlayState(shouldPlay: boolean): void {
    // Both players during a fade: pausing must silence the outgoing track too.
    for (const player of [this.main, this.outgoing]) {
      if (!player) continue;
      try {
        if (shouldPlay) player.play();
        else player.pause();
      } catch {
        // The status listener will reconcile on the next tick.
      }
    }
  }

  private startFade(outgoing: EnginePlayer, startVolume: number, seconds: number): void {
    const started = Date.now();
    const total = Math.max(FADE_STEP_MS, seconds * 1000);

    this.fadeTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / total);
      this.fadeGain = progress;
      this.applyGain();
      try {
        outgoing.setVolume(unit(startVolume * (1 - progress)));
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

  /** Stops the ramp and releases the outgoing player. */
  private releaseOutgoing(): void {
    this.clearFade();
    this.fadeGain = 1;
    const outgoing = this.outgoing;
    this.outgoing = null;
    if (!outgoing) return;
    try {
      outgoing.pause();
      outgoing.release();
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
    if (!this.main || !Number.isFinite(seconds)) return;
    // Keep only the newest target. A seek issued while the source is loading
    // or buffering is applied as soon as the player reports that it is ready.
    this.pendingSeek = Math.max(0, seconds);
    await this.flushSeek();
  }

  private async flushSeek(): Promise<void> {
    if (this.seeking || this.pendingSeek == null) return;
    const player = this.main;
    if (!player || !this.isLoaded || this.isBuffering) return;

    const target = this.pendingSeek;
    this.pendingSeek = null;
    this.seeking = true;
    try {
      await player.seek(target);
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
    if (!this.main) return;
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
    this.isLoaded = false;
    this.isBuffering = false;
    this.playing = false;
    this.pendingSeek = null;
    const player = this.main;
    this.main = null;
    if (player) {
      try {
        player.pause();
        player.release();
      } catch {
        // ignore
      }
    }
    this.loadedId = null;
  }

  /** Drops the backend subscription; the engine is unusable afterwards. */
  protected dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
