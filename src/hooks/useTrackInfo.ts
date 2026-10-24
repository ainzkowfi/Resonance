import { useEffect, useState } from 'react';

import { enrichTrack } from '../metadata';
import type { Track, TrackInfo } from '../types/track';

/** Session cache so re-opening a track does not re-hit every provider. */
const sessionCache = new Map<string, TrackInfo>();

/**
 * Progressive metadata for a track.
 *
 * `enrichTrack` publishes partial results as each provider answers, so the
 * lyrics can show up before the similar songs have finished loading.
 */
export function useTrackInfo(track: Track | null | undefined) {
  const [state, setState] = useState<{ key: string; info?: TrackInfo }>({ key: '' });

  useEffect(() => {
    if (!track || sessionCache.has(track.id)) return;

    let cancelled = false;

    void enrichTrack(track, {
      onUpdate: (partial) => {
        if (cancelled) return;
        sessionCache.set(track.id, partial);
        setState({ key: track.id, info: partial });
      },
    })
      .then((full) => {
        if (cancelled) return;
        sessionCache.set(track.id, full);
        setState({ key: track.id, info: full });
      })
      .catch(() => {
        if (!cancelled) setState({ key: track.id, info: undefined });
      });

    return () => {
      cancelled = true;
    };
  }, [track]);

  const key = track?.id ?? '';
  const cached = track ? sessionCache.get(track.id) : undefined;
  if (cached) return cached;
  return state.key === key ? state.info : undefined;
}
