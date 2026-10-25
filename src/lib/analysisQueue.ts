/**
 * Which tracks a batch analysis run should decode.
 *
 * Kept pure so the rule — skip anything already cached, skip anything without a
 * source, stop at the cap, keep library order — is covered by
 * `scripts/check.mts` instead of only by hand-testing on a device.
 */

/** A run is a snack break, not a full-library migration. */
export const MAX_TRACKS_PER_RUN = 200;

export function planAnalysisQueue<T extends { id: string; uri: string }>(
  tracks: readonly T[],
  isAnalyzed: (trackId: string) => boolean,
  limit = MAX_TRACKS_PER_RUN,
): T[] {
  if (limit <= 0) return [];

  const queue: T[] = [];
  for (const track of tracks) {
    if (!track.uri) continue;
    if (isAnalyzed(track.id)) continue;
    queue.push(track);
    if (queue.length >= limit) break;
  }
  return queue;
}
