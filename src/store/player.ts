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
      repeat: 'all',
      originalQueue: [],
      resumePosition: 0,

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
        });
        loadTrack(track, { autoplay: true });
      },

      toggle: () => {
        const { isPlaying, currentTrack } = get();
        if (!currentTrack) return;
        const next = !isPlaying;
        set({ isPlaying: next, resumePosition: get().position });
        if (next) audioEngine.play();
        else audioEngine.pause();
      },

      next: () => {
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

      applyStatus: (status) => {
        const state = get();
        if (status.didJustFinish) {
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

// The engine reports progress here; the engine itself never imports the store.
audioEngine.setStatusListener((status) => usePlayerStore.getState().applyStatus(status));
