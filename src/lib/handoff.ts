/**
 * Track handoff timing.
 *
 * "Gapless" is only worth building if the measured gap between tracks is
 * actually large, and the only way to know is to time the real thing. Two
 * numbers are recorded per transition:
 *
 * - **queue delay** — from the engine being asked to load the next track to the
 *   moment it calls `play()`. This is the store and player-creation overhead.
 * - **start latency** — from `play()` to audio actually advancing. The player's
 *   own `currentTime` gives this sub-tick precision: at the first status where
 *   audio is moving, `elapsed − currentTime` is how long the decoder took.
 *
 * The player's status interval quantises *when* we notice, not the answer.
 */

export interface HandoffTiming {
  requestedAt: number;
  playRequestedAt: number;
  firstAudibleAt: number;
  /** Seconds reported by the first status where audio was moving. */
  currentTime: number;
  crossfade: boolean;
}

export interface HandoffSample {
  at: number;
  queueDelayMs: number;
  startLatencyMs: number;
  totalMs: number;
  /** Blends are measured too, but excluded from the hard-cut summary. */
  crossfade: boolean;
}

/** A transition slower than this is a stall, not a handoff: discard it. */
export const MAX_TRUSTED_MS = 5000;

export function sampleFromTiming(timing: HandoffTiming): HandoffSample | undefined {
  const playRequestedAt = timing.playRequestedAt || timing.requestedAt;
  const queueDelayMs = Math.max(0, playRequestedAt - timing.requestedAt);
  const sincePlay = timing.firstAudibleAt - playRequestedAt;
  if (!Number.isFinite(sincePlay) || sincePlay <= 0) return undefined;
  if (sincePlay > MAX_TRUSTED_MS) return undefined;

  // The player reports the position it has already reached, so subtract it.
  const playedMs = Number.isFinite(timing.currentTime) ? timing.currentTime * 1000 : 0;
  const startLatencyMs = Math.max(0, Math.round(sincePlay - playedMs));

  return {
    at: timing.firstAudibleAt,
    queueDelayMs: Math.round(queueDelayMs),
    startLatencyMs,
    totalMs: Math.round(queueDelayMs) + startLatencyMs,
    crossfade: timing.crossfade,
  };
}

export function median(values: readonly number[]): number {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) return 0;
  const middle = usable.length >> 1;
  return usable.length % 2 === 1
    ? usable[middle]
    : Math.round((usable[middle - 1] + usable[middle]) / 2);
}

export interface HandoffSummary {
  count: number;
  medianMs: number;
  worstMs: number;
}

/** Summary of hard-cut transitions only; `null` until one has been measured. */
export function summarizeHandoffs(samples: readonly HandoffSample[]): HandoffSummary | null {
  const hardCuts = samples.filter((sample) => !sample.crossfade).map((sample) => sample.totalMs);
  if (hardCuts.length === 0) return null;
  return {
    count: hardCuts.length,
    medianMs: median(hardCuts),
    worstMs: Math.max(...hardCuts),
  };
}
