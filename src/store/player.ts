import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist, type PersistStorage } from 'zustand/middleware';
import { audioEngine } from '../audio/engine';
import { playbackCopy, playbackCopyFile } from '../ffmpeg/transcode';
import { loadAnalysis, type TrackAnalysis } from '../ffmpeg/waveform';
import { crossfadeStart, normalizeCrossfade } from '../lib/crossfade';
import { shuffleArray } from '../lib/format';
import { sampleFromTiming } from '../lib/handoff';
import { isExternalStop } from '../lib/interruption';
import { targetFromSamples, trackGainDb, volumeForGain } from '../lib/leveling';
import {
  LOAD_WATCHDOG_MS,
  stalledLoadFailure,
  type LoadProgress,
} from '../lib/loadWatchdog';
import {
  playbackPlatform,
  shouldTranscode,
  unsupportedReason,
  type PlaybackNotice,
} from '../lib/playbackSupport';
import { shouldPreload } from '../lib/preload';
import { leadSkip, tailOut } from '../lib/silence';
import { describeError, useDiagnosticsStore } from './diagnostics';
import type { RepeatMode, Track } from '../types/track';

/**
 * Queue and playback state.
 *
 * The store owns the queue; `audioEngine` owns exactly one playing track. The
 * store calls the engine to change tracks, and the engine reports progress
 * back through a listener registered at the bottom of this file.
 */

export interface PlayerState {
  queue: Track[];
  queueIndex: number;
  currentTrack: Track | null;
  isPlaying: boolean;
  /** Runtime-only, seconds. */
  position: number;
  /** Runtime-only, seconds. */
  duration: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** The unshuffled queue, kept so shuffle can be undone. */
  originalQueue: Track[];
  /** Persisted checkpoint written on pause / track change / unmount. */
  resumePosition: number;
  /** Volume leveling: turns loud tracks down to the library's median loudness. */
  leveling: boolean;
  /** Measured loudness (dBFS) per track id, persisted so leveling is instant. */
  levels: Record<string, number>;
  /** Skip excessive silence at the start and end of a track. */
  skipSilence: boolean;
  /** Trailing silence of the loaded track, seconds. Runtime-only. */
  silenceTail: number;
  /** Blend length between queued tracks, seconds. 0 turns crossfading off. */
  crossfade: number;
  /** Why the current track would not play, or that it is being prepared. */
  notice: PlaybackNotice | null;
  /** Track whose playable copy is being produced, so its row can say so. */
  preparingId: string | null;

  playTracks: (tracks: Track[], startIndex?: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  playAt: (index: number) => void;
  seek: (seconds: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  removeAt: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  setLeveling: (enabled: boolean) => void;
  setSkipSilence: (enabled: boolean) => void;
  setCrossfade: (seconds: number) => void;
  recordLevel: (trackId: string, rmsDb: number) => void;
  dismissNotice: () => void;
  applyStatus: (status: {
    currentTime: number;
    duration: number;
    playing: boolean;
    didJustFinish: boolean;
    isLoaded: boolean;
    isBuffering: boolean;
    error?: string | null;
  }) => void;
}

/** The slice of state that survives a restart. */
interface PersistedPlayerState {
  queue: Track[];
  queueIndex: number;
  currentTrack: Track | null;
  resumePosition: number;
  shuffle: boolean;
  repeat: RepeatMode;
  originalQueue: Track[];
  isPlaying: boolean;
  leveling: boolean;
  levels: Record<string, number>;
  skipSilence: boolean;
  crossfade: number;
}

/** Median loudness only needs a representative sample, not every track ever. */
const MAX_LEVEL_SAMPLES = 2000;

/** Skip disk writes when the serialized snapshot is unchanged. */
function createDedupedStorage<S>(): PersistStorage<S> {
  const base = createJSONStorage<S>(() => AsyncStorage)!;
  let last: string | null = null;
  return {
    getItem: async (name) => {
      const value = await base.getItem(name);
      if (value != null) last = JSON.stringify(value);
      return value;
    },
    setItem: async (name, value) => {
      const serialized = JSON.stringify(value);
      if (serialized === last) return;
      last = serialized;
      await base.setItem(name, value);
    },
    removeItem: async (name) => {
      last = null;
      await base.removeItem(name);
    },
  };
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      queueIndex: 0,
      currentTrack: null,
      isPlaying: false,
      position: 0,
      duration: 0,
      shuffle: false,
      repeat: 'all',
      originalQueue: [],
      resumePosition: 0,
      leveling: false,
      levels: {},
      skipSilence: false,
      silenceTail: 0,
      crossfade: 0,
      notice: null,
      preparingId: null,

      playTracks: (tracks, startIndex = 0) => {
        if (tracks.length === 0) return;
        const index = Math.max(0, Math.min(startIndex, tracks.length - 1));
        const track = tracks[index];
        set({
          queue: tracks,
          queueIndex: index,
          currentTrack: track,
          isPlaying: true,
          position: 0,
          duration: track.duration,
          resumePosition: 0,
          shuffle: false,
          originalQueue: [],
          notice: null,
        });
        loadTrack(track, { autoplay: true });
      },

      toggle: () => {
        const { isPlaying, currentTrack } = get();
        if (!currentTrack) return;
        const next = !isPlaying;
        set({ isPlaying: next, resumePosition: get().position });
        if (next) audioEngine.play();
        else {
          // A pause is deliberate: stop treating the load as stalled.
          clearWatchdog();
          audioEngine.pause();
        }
      },

      next: () => {
        const { queue, queueIndex, repeat, currentTrack } = get();
        if (queue.length === 0) return;

        if (repeat === 'one' && currentTrack) {
          set({ position: 0, resumePosition: 0, isPlaying: true });
          audioEngine.replay();
          // A repeat is a fresh start, so the intro gap is skipped again.
          void applyTrackAnalysis(currentTrack);
          return;
        }

        const isLast = queueIndex >= queue.length - 1;
        if (isLast && repeat !== 'all') {
          set({ isPlaying: false, position: 0 });
          audioEngine.pause();
          return;
        }
        const nextIndex = isLast ? 0 : queueIndex + 1;
        const track = queue[nextIndex];
        set({
          currentTrack: track,
          queueIndex: nextIndex,
          position: 0,
          duration: track.duration,
          resumePosition: 0,
          isPlaying: true,
          notice: null,
        });
        loadTrack(track, { autoplay: true, crossfade: true });
      },

      previous: () => {
        const { queue, queueIndex, position } = get();
        if (queue.length === 0) return;
        // Standard behaviour: restart the track if we are past the 3s mark.
        if (position > 3) {
          set({ position: 0, resumePosition: 0 });
          void audioEngine.seek(0);
          return;
        }
        if (queueIndex > 0) {
          const prevIndex = queueIndex - 1;
          const track = queue[prevIndex];
          set({
            currentTrack: track,
            queueIndex: prevIndex,
            position: 0,
            duration: track.duration,
            resumePosition: 0,
            isPlaying: true,
            notice: null,
          });
          loadTrack(track, { autoplay: true });
        } else {
          set({ position: 0, resumePosition: 0 });
          void audioEngine.seek(0);
        }
      },

      playAt: (index) => {
        const state = get();
        const track = state.queue[index];
        if (!track) return;
        if (index === state.queueIndex && track.id === state.currentTrack?.id) return;
        set({
          currentTrack: track,
          queueIndex: index,
          position: 0,
          duration: track.duration,
          resumePosition: 0,
          isPlaying: true,
          notice: null,
        });
        loadTrack(track, { autoplay: true });
      },

      seek: (seconds) => {
        const clamped = Math.max(0, seconds);
        if (!Number.isFinite(clamped)) return;
        set({ position: clamped, resumePosition: clamped });
        void audioEngine.seek(clamped);
      },

      setRepeat: (mode) => set({ repeat: mode }),

      toggleShuffle: () => {
        const { shuffle, queue, currentTrack, originalQueue } = get();
        if (shuffle) {
          const restored = originalQueue.length ? originalQueue : queue;
          const index = currentTrack ? restored.findIndex((t) => t.id === currentTrack.id) : -1;
          set({
            shuffle: false,
            queue: restored,
            queueIndex: index >= 0 ? index : 0,
            originalQueue: [],
          });
          return;
        }
        const restored = originalQueue.length ? originalQueue : queue;
        const shuffled = shuffleArray(queue);
        if (currentTrack) {
          const rest = shuffled.filter((t) => t.id !== currentTrack.id);
          set({
            shuffle: true,
            originalQueue: restored,
            queue: [currentTrack, ...rest],
            queueIndex: 0,
          });
        } else {
          set({ shuffle: true, originalQueue: restored, queue: shuffled });
        }
      },

      toggleRepeat: () => {
        const { repeat } = get();
        set({ repeat: repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off' });
      },

      removeAt: (index) => {
        const { queue, queueIndex } = get();
        if (index < 0 || index >= queue.length) return;
        const nextQueue = queue.filter((_, i) => i !== index);
        if (nextQueue.length === 0) {
          set({
            queue: [],
            queueIndex: 0,
            currentTrack: null,
            isPlaying: false,
            position: 0,
            duration: 0,
            resumePosition: 0,
          });
          audioEngine.unload();
          return;
        }
        let nextIndex = queueIndex;
        if (index < queueIndex) nextIndex = queueIndex - 1;
        else if (index === queueIndex) nextIndex = Math.min(queueIndex, nextQueue.length - 1);

        if (index === queueIndex) {
          const track = nextQueue[nextIndex];
          set({
            queue: nextQueue,
            queueIndex: nextIndex,
            currentTrack: track,
            position: 0,
            duration: track.duration,
            resumePosition: 0,
          });
          loadTrack(track, { autoplay: true });
          return;
        }
        set({ queue: nextQueue, queueIndex: nextIndex });
      },

      moveInQueue: (from, to) => {
        const { queue, queueIndex, currentTrack } = get();
        if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) return;
        const nextQueue = [...queue];
        const [moved] = nextQueue.splice(from, 1);
        nextQueue.splice(to, 0, moved);
        const index = currentTrack ? nextQueue.findIndex((t) => t.id === currentTrack.id) : -1;
        set({ queue: nextQueue, queueIndex: index >= 0 ? index : queueIndex });
      },

      clearQueue: () => {
        set({
          queue: [],
          queueIndex: 0,
          currentTrack: null,
          isPlaying: false,
          position: 0,
          duration: 0,
          resumePosition: 0,
          shuffle: false,
          originalQueue: [],
        });
        audioEngine.unload();
      },

      setLeveling: (enabled) => {
        set({ leveling: enabled });
        const { currentTrack } = get();
        if (currentTrack) void applyTrackAnalysis(currentTrack, { seekLead: false });
        else audioEngine.setLevelGain(1);
      },

      setSkipSilence: (enabled) => {
        set({ skipSilence: enabled, silenceTail: enabled ? get().silenceTail : 0 });
        const { currentTrack } = get();
        // Never jump the track that is already playing; only learn its outro.
        if (enabled && currentTrack) void applyTrackAnalysis(currentTrack, { seekLead: false });
      },

      setCrossfade: (seconds) => set({ crossfade: normalizeCrossfade(seconds) }),

      recordLevel: (trackId, rmsDb) => {
        if (!Number.isFinite(rmsDb)) return;
        set((state) => {
          if (state.levels[trackId] === rmsDb) return state;
          const levels = { ...state.levels, [trackId]: rmsDb };
          const keys = Object.keys(levels);
          if (keys.length > MAX_LEVEL_SAMPLES) delete levels[keys[0]];
          return { levels };
        });
      },

      dismissNotice: () => set({ notice: null }),

      applyStatus: (status) => {
        const state = get();

        // Anything that proves the source opened stands the watchdog down.
        loadProgress = {
          loaded: status.isLoaded,
          currentTime: status.currentTime,
          playing: status.playing,
          error: status.error ?? null,
        };
        if (status.isLoaded || status.playing || status.currentTime > 0) clearWatchdog();

        // A source the platform cannot decode usually shows up here rather
        // than as a thrown load, so a track that fails this way is reported,
        // not left looking like a stopped player.
        if (status.error && status.error !== lastPlaybackError) {
          lastPlaybackError = status.error;
          if (state.currentTrack) {
            void recoverTrack(state.currentTrack, new Error(status.error), { autoplay: true });
          }
        }

        // Neither platform reports an audio interruption to JavaScript, so a
        // stop that nothing of ours asked for is the signal that something else
        // took the audio: a call, a video, another player.
        if (status.playing) {
          if (playingSince === 0) playingSince = Date.now();
        } else if (
          isExternalStop({
            expectedPlaying: state.isPlaying,
            playing: status.playing,
            isLoaded: status.isLoaded,
            isBuffering: status.isBuffering,
            didJustFinish: status.didJustFinish,
            msSincePlaying: playingSince === 0 ? 0 : Date.now() - playingSince,
          })
        ) {
          playingSince = 0;
          void audioEngine.fadeOutAndPause();
          noticeFor({ tone: 'info', message: 'Paused while another app played audio.' });
        }

        if (status.didJustFinish) {
          state.next();
          return;
        }

        // Open the next track shortly before the boundary so the handoff is a
        // play() on something already loaded.
        const currentId = state.currentTrack?.id;
        if (
          currentId &&
          state.repeat !== 'one' &&
          state.queue.length > 0 &&
          shouldPreload({
            duration: state.duration,
            currentTime: status.currentTime,
            prepared: preparedFor === currentId,
          })
        ) {
          const upcoming = state.queue[(state.queueIndex + 1) % state.queue.length];
          if (upcoming && upcoming.id !== currentId) {
            preparedFor = currentId;
            audioEngine.prepare({ ...upcoming, uri: playableUri(upcoming) });
          }
        }
        if (status.playing) {
          // Advance early enough to blend into the next track, or at the start
          // of the outro when silence skipping is on. Whichever comes first.
          const out = state.skipSilence ? tailOut(state.duration, state.silenceTail) : 0;
          const blend = crossfadeStart(state.duration, state.crossfade);
          const advanceAt = out > 0 && blend > 0 ? Math.min(out, blend) : out > 0 ? out : blend;
          if (advanceAt > 0 && status.currentTime >= advanceAt) {
            state.next();
            return;
          }
        }
        set({
          position: status.currentTime,
          duration: status.duration || state.duration,
          // Startup and buffering both report `playing: false`; only
          // reconcile once the source is actually loaded.
          isPlaying: status.isLoaded && !status.isBuffering ? status.playing : state.isPlaying,
        });
      },
    }),
    {
      name: 'resonance-player',
      storage: createDedupedStorage<PersistedPlayerState>(),
      version: 3,
      migrate: (persisted, version) => {
        let next = persisted as PersistedPlayerState;
        if (version < 2) {
          const previous = next;
          const isLocal = (track: Track | null | undefined) =>
            Boolean(track && track.source === 'local' && !/^https?:\/\//i.test(track.uri));
          const queue = (previous.queue ?? []).filter(isLocal);
          const originalQueue = (previous.originalQueue ?? []).filter(isLocal);
          const preferredId = isLocal(previous.currentTrack)
            ? previous.currentTrack?.id
            : previous.queue?.[previous.queueIndex]?.id;
          const queueIndex = preferredId
            ? queue.findIndex((track) => track.id === preferredId)
            : -1;

          next = {
            ...previous,
            queue,
            originalQueue,
            queueIndex: queueIndex >= 0 ? queueIndex : 0,
            currentTrack: queueIndex >= 0 ? queue[queueIndex] : null,
            resumePosition: queueIndex >= 0 ? (previous.resumePosition ?? 0) : 0,
            isPlaying: false,
          };
        }
        if (version < 3) next = { ...next, repeat: 'all' };
        return next;
      },
      partialize: (state): PersistedPlayerState => ({
        queue: state.queue,
        queueIndex: state.queueIndex,
        currentTrack: state.currentTrack,
        resumePosition: state.resumePosition,
        shuffle: state.shuffle,
        repeat: state.repeat,
        originalQueue: state.originalQueue,
        isPlaying: false,
        leveling: state.leveling,
        levels: state.levels,
        skipSilence: state.skipSilence,
        crossfade: state.crossfade,
      }),
    },
  ),
);

/**
 * Leveling gain for a track, using anything already measured.
 *
 * Computed synchronously so a track starts at the right volume: waiting for the
 * analysis would let the first second play at full level and then jump.
 */
function levelGainFor(track: Track, levels: Record<string, number>): number {
  if (!usePlayerStore.getState().leveling) return 1;
  const targetDb = targetFromSamples(Object.values(levels));
  const gainDb = trackGainDb({ rmsDb: levels[track.id], tagGainDb: track.gain, targetDb });
  return volumeForGain(gainDb);
}

/** The track whose successor has already been opened, if any. */
let preparedFor: string | null = null;

/** Tracks that have already been through one conversion attempt. */
const convertedOnce = new Set<string>();
/** Tracks whose copy is being produced right now. */
const converting = new Set<string>();
/** Last native error reported, so a repeating status does not retry forever. */
let lastPlaybackError = '';
/** Last failure already written to diagnostics, so one refusal logs once. */
let lastReportedFailure = '';
/** Timer for a load that has produced nothing yet. */
let watchdog: ReturnType<typeof setTimeout> | null = null;
/** What the latest engine status says about the current load. */
let loadProgress: LoadProgress = { loaded: false, currentTime: 0, playing: false, error: null };
/** When the current track first reported that it was actually playing. */
let playingSince = 0;

function clearWatchdog(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
}

/**
 * Arms the silent-failure watch for a load that was asked to play.
 *
 * A source the platform cannot parse does not always reject or report an error
 * — it can simply never load. Without this, that track would look paused
 * forever, which is the exact symptom this whole path exists to remove.
 */
function armWatchdog(track: Track, options: { autoplay?: boolean; startAt?: number }): void {
  clearWatchdog();
  loadProgress = { loaded: false, currentTime: 0, playing: false, error: null };
  watchdog = setTimeout(() => {
    watchdog = null;
    if (usePlayerStore.getState().currentTrack?.id !== track.id) return;
    const reason = stalledLoadFailure(loadProgress);
    if (!reason) return;
    void recoverTrack(track, new Error(reason), options);
  }, LOAD_WATCHDOG_MS);
}

function noticeFor(notice: PlaybackNotice | null): void {
  usePlayerStore.setState({ notice });
}

/**
 * The recovery path for a track the native player refused.
 *
 * Before this existed a refusal was invisible: the console got a warning and
 * the player simply stopped. Now every failure leaves a diagnostics entry and a
 * line in the player, and a format the platform cannot open gets one attempt at
 * a converted copy before the track is given up on.
 */
async function recoverTrack(
  track: Track,
  error: unknown,
  options: { autoplay?: boolean; startAt?: number },
): Promise<void> {
  const info = describeError(error);
  const detail = [info.message, info.stack].filter(Boolean).join('\n');

  // A load rejection and a status error can describe the same refusal; one
  // entry is enough, and repeat reports from a stuck player are worse.
  const failure = `${track.id}:${info.message}`;
  if (failure !== lastReportedFailure) {
    lastReportedFailure = failure;
    useDiagnosticsStore.getState().addIssue('playback', `Could not play “${track.title}”.`, detail);
  }

  if (converting.has(track.id)) return;

  const platform = playbackPlatform(Platform.OS);
  const reason = unsupportedReason(track.uri, platform);

  if (!shouldTranscode(track.uri, platform)) {
    noticeFor({ tone: 'error', message: reason ?? `This track would not play: ${info.message}`, detail });
    return;
  }

  if (convertedOnce.has(track.id)) {
    noticeFor({ tone: 'error', message: 'The converted copy would not play either.', detail });
    return;
  }
  convertedOnce.add(track.id);
  converting.add(track.id);
  usePlayerStore.setState({ preparingId: track.id });

  try {
    noticeFor({
      tone: 'info',
      message: `${reason ?? 'This format is not supported'} Making a playable copy…`,
    });
    const copy = await playbackCopy(track);

    // The user may have moved on while the encode ran.
    if (usePlayerStore.getState().currentTrack?.id !== track.id) return;

    if (!copy.ok) {
      useDiagnosticsStore
        .getState()
        .addIssue(
          'playback',
          `Could not convert “${track.title}” for playback.`,
          [copy.message, copy.detail].filter(Boolean).join('\n'),
        );
      noticeFor({ tone: 'error', message: copy.message, detail: copy.detail });
      return;
    }

    noticeFor({ tone: 'info', message: 'Playing a converted copy of this track.' });
    loadTrack(track, options);
  } finally {
    converting.delete(track.id);
    usePlayerStore.setState({ preparingId: null });
  }
}

/**
 * The URI to hand the native player for a track.
 *
 * A converted copy is used from then on, so replaying a track that iOS cannot
 * open costs a file check rather than another encode — and returning to it
 * later, or after a restart, is instant.
 */
function playableUri(track: Track): string {
  if (!shouldTranscode(track.uri, playbackPlatform(Platform.OS))) return track.uri;
  try {
    const copy = playbackCopyFile(track.id);
    return copy.exists ? copy.uri : track.uri;
  } catch {
    return track.uri;
  }
}

/** Load through one place so a failed native load can never surface as an unhandled rejection. */
function loadTrack(
  track: Track,
  options: { autoplay?: boolean; startAt?: number; crossfade?: boolean } = {},
): void {
  const { crossfade = false, autoplay, startAt } = options;
  preparedFor = null;
  lastPlaybackError = '';
  playingSince = 0;
  const state = usePlayerStore.getState();
  const seconds = crossfade ? state.crossfade : 0;
  const gain = levelGainFor(track, state.levels);
  // A copy produced by an earlier failure is what actually plays.
  const source = { ...track, uri: playableUri(track) };

  let run: Promise<void>;
  if (seconds > 0) {
    run = audioEngine.crossfadeTo(source, { autoplay, startAt, seconds, gain });
  } else {
    audioEngine.setLevelGain(gain);
    run = audioEngine.load(source, { autoplay, startAt });
  }

  if (autoplay) armWatchdog(track, { autoplay, startAt });

  void run
    // Analysis is cosmetic: never let it surface as a failed load.
    .then(() => applyTrackAnalysis(track).catch(() => undefined))
    .catch((error: unknown) => {
      if (usePlayerStore.getState().currentTrack?.id === track.id) {
        usePlayerStore.setState({ isPlaying: false });
      }
      void recoverTrack(track, error, { autoplay, startAt });
    });
}

/** Guards against a slow analysis landing after the track changed again. */
let analysisToken = 0;

/**
 * Applies everything the per-track analysis feeds: leveling and silence
 * skipping.
 *
 * Runs after the source is loaded, so a first-time decode never delays
 * playback. `player.volume` caps at 1, so the leveling target is the library's
 * median loudness: louder tracks come down to it, quieter ones are left alone.
 * `seekLead: false` learns the outro without moving the track that is already
 * playing.
 */
async function applyTrackAnalysis(
  track: Track,
  options: { seekLead?: boolean } = {},
): Promise<void> {
  const token = ++analysisToken;
  const { seekLead = true } = options;
  const initial = usePlayerStore.getState();
  const wantLeveling = initial.leveling;
  const wantSilence = initial.skipSilence;

  if (!track.uri || (!wantLeveling && !wantSilence)) {
    audioEngine.setLevelGain(1);
    usePlayerStore.setState({ silenceTail: 0 });
    return;
  }

  usePlayerStore.setState({ silenceTail: 0 });

  let analysis: TrackAnalysis | undefined;
  try {
    analysis = await loadAnalysis(track.id, track.uri);
  } catch {
    analysis = undefined;
  }
  if (token !== analysisToken) return;

  const current = usePlayerStore.getState();
  if (current.currentTrack?.id !== track.id) return;

  if (wantLeveling) {
    if (analysis && Number.isFinite(analysis.rmsDb)) {
      current.recordLevel(track.id, analysis.rmsDb);
    }
    const targetDb = targetFromSamples(Object.values(usePlayerStore.getState().levels));
    const gainDb = trackGainDb({ rmsDb: analysis?.rmsDb, tagGainDb: track.gain, targetDb });
    audioEngine.setLevelGain(volumeForGain(gainDb));
  } else {
    audioEngine.setLevelGain(1);
  }

  if (wantSilence && analysis) {
    usePlayerStore.setState({ silenceTail: analysis.tail });
    const start = leadSkip(analysis.lead, usePlayerStore.getState().position);
    if (seekLead && start > 0) {
      usePlayerStore.setState({ position: start, resumePosition: start });
      void audioEngine.seek(start);
    }
  }
}

let didRestore = false;

/** Put the persisted track back into the engine on a cold start. */
function restorePersistedPlayback(): void {
  if (didRestore) return;
  didRestore = true;
  const state = usePlayerStore.getState();
  if (!state.currentTrack || state.isPlaying) return;
  usePlayerStore.setState({ position: state.resumePosition });
  loadTrack(state.currentTrack, { startAt: state.resumePosition });
}

usePlayerStore.persist.onFinishHydration(restorePersistedPlayback);
if (usePlayerStore.persist.hasHydrated()) restorePersistedPlayback();

// The engine reports progress here; the engine itself never imports the store.
audioEngine.setStatusListener((status) => usePlayerStore.getState().applyStatus(status));

// Track-change timings feed the handoff measurement in Diagnostics.
audioEngine.setHandoffListener((timing) => {
  const sample = sampleFromTiming(timing);
  if (sample) useDiagnosticsStore.getState().recordHandoff(sample);
});
