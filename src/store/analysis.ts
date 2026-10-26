import { create } from 'zustand';

import { hasAnalysis, loadAnalysis, pruneAnalysis } from '../media/waveform';
import { planAnalysisQueue } from '../lib/analysisQueue';
import type { Track } from '../types/track';
import { usePlayerStore } from './player';

/**
 * Batch analysis runner.
 *
 * Waveforms, loudness leveling and silence skipping all read one cached
 * analysis per track, so a library-wide pass makes those features work
 * everywhere instead of only on tracks already played. It is deliberately
 * explicit: nothing runs until the user asks, one track at a time, and it can
 * be stopped.
 */

/** Cache probes per tick; a stat storm on the JS thread is not acceptable. */
const COUNT_CHUNK = 250;

interface AnalysisRunState {
  running: boolean;
  done: number;
  total: number;
  /** Title of the track being decoded. */
  current: string | null;
  /** Tracks with cached analysis; `null` while the first count is running. */
  analyzed: number | null;
  start: (tracks: Track[]) => void;
  cancel: () => void;
  countAnalyzed: (tracks: Track[]) => void;
}

/** Bumped on cancel so a loop that is mid-decode cannot touch newer state. */
let runToken = 0;
let countToken = 0;

export const useAnalysisRunStore = create<AnalysisRunState>((set, get) => ({
  running: false,
  done: 0,
  total: 0,
  current: null,
  analyzed: null,

  start: (tracks) => {
    if (get().running) return;

    const token = ++runToken;
    const queue = planAnalysisQueue(tracks, hasAnalysis);

    if (queue.length === 0) {
      set({ running: false, done: 0, total: 0, current: null });
      return;
    }

    set({ running: true, done: 0, total: queue.length, current: queue[0].title });

    void (async () => {
      // Housekeeping first: drop analysis for tracks that left the library.
      await pruneAnalysis(tracks.map((track) => track.id));

      let done = 0;
      for (const track of queue) {
        if (token !== runToken) return;
        set({ current: track.title });

        const analysis = await loadAnalysis(track.id, track.uri).catch(() => undefined);
        if (token !== runToken) return;

        if (analysis && Number.isFinite(analysis.rmsDb)) {
          usePlayerStore.getState().recordLevel(track.id, analysis.rmsDb);
        }

        done += 1;
        set({ done });
      }

      if (token !== runToken) return;
      set({ running: false, current: null });
      // The run added entries, so the "analysed" figure changed.
      get().countAnalyzed(tracks);
    })();
  },

  cancel: () => {
    runToken += 1;
    set({ running: false, current: null });
  },

  /**
   * Counts tracks that already have cached analysis.
   *
   * Chunked through the event loop: probing thousands of files synchronously
   * would stall the screen that displays the number.
   */
  countAnalyzed: (tracks) => {
    const token = ++countToken;
    let index = 0;
    let count = 0;

    const step = () => {
      if (token !== countToken) return;
      const until = Math.min(tracks.length, index + COUNT_CHUNK);
      for (; index < until; index++) {
        if (hasAnalysis(tracks[index].id)) count += 1;
      }
      set({ analyzed: count });
      if (index < tracks.length) setTimeout(step, 0);
    };

    step();
  },
}));
