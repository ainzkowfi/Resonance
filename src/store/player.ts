import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist, type PersistStorage } from 'zustand/middleware';
import { audioEngine } from '../audio/engine';
import { shuffleArray } from '../lib/format';
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
  /** Blend the last seconds of a track into the next one. */
  crossfade: boolean;
  /** The unshuffled queue, kept so shuffle can be undone. */
  originalQueue: Track[];
  /** Persisted checkpoint written on pause / track change / unmount. */
  resumePosition: number;

  playTracks: (tracks: Track[], startIndex?: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  toggleCrossfade: () => void;
  removeAt: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  applyStatus: (status: {
    currentTime: number;
    duration: number;
    playing: boolean;
    didJustFinish: boolean;
    isLoaded: boolean;
    isBuffering: boolean;
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
  crossfade: boolean;
  originalQueue: Track[];
  isPlaying: boolean;
}

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
      repeat: 'off',
      crossfade: true,
      originalQueue: [],
      resumePosition: 0,

      playTracks: (tracks, startIndex = 0) => {
        if (tracks.length === 0) return;
        cancelTransition();
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
        });
        loadTrack(track, { autoplay: true });
      },

      toggle: () => {
        cancelTransition();
        const { isPlaying, currentTrack } = get();
        if (!currentTrack) return;
        const next = !isPlaying;
        set({ isPlaying: next, resumePosition: get().position });
        if (next) audioEngine.play();
        else audioEngine.pause();
      },

      next: () => {
        cancelTransition();
        const { queue, queueIndex, repeat, currentTrack } = get();
        if (queue.length === 0) return;

        if (repeat === 'one' && currentTrack) {
          set({ position: 0, resumePosition: 0, isPlaying: true });
          audioEngine.replay();
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
        });
        loadTrack(track, { autoplay: true });
      },

      previous: () => {
        cancelTransition();
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
          });
          loadTrack(track, { autoplay: true });
        } else {
          set({ position: 0, resumePosition: 0 });
          void audioEngine.seek(0);
        }
      },

      seek: (seconds) => {
        cancelTransition();
        const clamped = Math.max(0, seconds);
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

      toggleCrossfade: () => {
        const { crossfade } = get();
        if (crossfade) cancelTransition();
        set({ crossfade: !crossfade });
      },

      removeAt: (index) => {
        cancelTransition();
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
        cancelTransition();
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

      applyStatus: (status) => {
        const state = get();
        if (status.didJustFinish) {
          if (crossfading) return;
          state.next();
          return;
        }
        set({
          position: status.currentTime,
          duration: status.duration || state.duration,
          // Startup and buffering both report `playing: false`; only
          // reconcile once the source is actually loaded.
          isPlaying: status.isLoaded && !status.isBuffering ? status.playing : state.isPlaying,
        });
        if (status.playing) maybeCrossfade(status.currentTime, status.duration || state.duration);
      },
    }),
    {
      name: 'resonance-player',
      storage: createDedupedStorage<PersistedPlayerState>(),
      version: 2,
      migrate: (persisted, version) => {
        if (version < 2) {
          const previous = persisted as PersistedPlayerState;
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

          return {
            ...previous,
            queue,
            originalQueue,
            queueIndex: queueIndex >= 0 ? queueIndex : 0,
            currentTrack: queueIndex >= 0 ? queue[queueIndex] : null,
            resumePosition: queueIndex >= 0 ? (previous.resumePosition ?? 0) : 0,
            isPlaying: false,
          };
        }
        return persisted as PersistedPlayerState;
      },
      partialize: (state): PersistedPlayerState => ({
        queue: state.queue,
        queueIndex: state.queueIndex,
        currentTrack: state.currentTrack,
        resumePosition: state.resumePosition,
        shuffle: state.shuffle,
        repeat: state.repeat,
        crossfade: state.crossfade,
        originalQueue: state.originalQueue,
        isPlaying: false,
      }),
    },
  ),
);

/** Load through one place so a failed native load can never surface as an unhandled rejection. */
function loadTrack(track: Track, options?: { autoplay?: boolean; startAt?: number }): void {
  void audioEngine.load(track, options).catch(() => {
    if (usePlayerStore.getState().currentTrack?.id === track.id) {
      usePlayerStore.setState({ isPlaying: false });
    }
  });
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

/** Longest overlap between two tracks; short tracks fade over at most half their length. */
const CROSSFADE_SECONDS = 6;
/** Head start for the incoming player to prepare and buffer. */
const CROSSFADE_PRELOAD = 1;

let crossfading = false;

function cancelTransition(): void {
  audioEngine.cancelCrossfade();
  crossfading = false;
}

/** Starts the crossfade once the current track is within its fade window. */
function maybeCrossfade(currentTime: number, duration: number): void {
  if (crossfading || duration <= 0) return;
  const state = usePlayerStore.getState();
  if (!state.crossfade) return;
  if (!state.isPlaying || !state.currentTrack || state.queue.length === 0) return;
  const isLast = state.queueIndex >= state.queue.length - 1;
  if (isLast && state.repeat === 'off') return;
  const nextIndex = state.repeat === 'one' ? state.queueIndex : isLast ? 0 : state.queueIndex + 1;
  const track = state.queue[nextIndex];
  if (!track) return;
  const fade = Math.min(
    CROSSFADE_SECONDS,
    duration / 4,
    track.duration > 0 ? track.duration / 4 : CROSSFADE_SECONDS,
  );
  if (fade < 0.5 || currentTime < duration - fade - CROSSFADE_PRELOAD) return;

  crossfading = true;
  const started = audioEngine.crossfade(
    track,
    fade,
    (position) => {
      crossfading = false;
      usePlayerStore.setState({
        currentTrack: track,
        queueIndex: nextIndex,
        isPlaying: true,
        position,
        duration: track.duration,
        resumePosition: position,
      });
    },
    () => {
      crossfading = false;
      const current = usePlayerStore.getState();
      if (current.duration > 0 && current.position >= current.duration - 0.1) current.next();
    },
  );
  if (!started) crossfading = false;
}

// The engine reports progress here; the engine itself never imports the store.
audioEngine.setStatusListener((status) => usePlayerStore.getState().applyStatus(status));
