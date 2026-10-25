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
  /** True when a preloaded player was promoted instead of a new one created. */
  preloaded: boolean;
}

export interface HandoffSample {
  at: number;
  queueDelayMs: number;
  startLatencyMs: number;
  totalMs: number;
  /** Blends are measured too, but excluded from the hard-cut summary. */
  crossfade: boolean;
  preloaded: boolean;
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
    preloaded: timing.preloaded,
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

export interface HandoffGroup {
  count: number;
  medianMs: number;
}

export interface HandoffSummary {
  count: number;
  medianMs: number;
  worstMs: number;
  /** Transitions where the next player was already open. */
  preloaded: HandoffGroup | null;
  /** Transitions that created a player at the boundary. */
  cold: HandoffGroup | null;
}

function group(totals: readonly number[]): HandoffGroup | null {
  if (totals.length === 0) return null;
  return { count: totals.length, medianMs: median(totals) };
}

/** Summary of hard-cut transitions only; `null` until one has been measured. */
export function summarizeHandoffs(samples: readonly HandoffSample[]): HandoffSummary | null {
  const hardCuts = samples.filter((sample) => !sample.crossfade);
  if (hardCuts.length === 0) return null;

  const all = hardCuts.map((sample) => sample.totalMs);
  return {
    count: all.length,
    medianMs: median(all),
    worstMs: Math.max(...all),
    preloaded: group(hardCuts.filter((s) => s.preloaded).map((s) => s.totalMs)),
    cold: group(hardCuts.filter((s) => !s.preloaded).map((s) => s.totalMs)),
  };
}
