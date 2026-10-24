import { useEffect, useState } from 'react';

import { readLocalLyrics } from '../library/local';
import type { Lyrics, Track } from '../types/track';

const lyricsCache = new Map<string, Lyrics | undefined>();

/** Reads embedded or sidecar lyrics once per track, without network requests. */
export function useTrackLyrics(track: Track | null | undefined) {
  const [state, setState] = useState<{ key: string; lyrics?: Lyrics }>({ key: '' });

  useEffect(() => {
    if (!track || lyricsCache.has(track.id)) return;

    let cancelled = false;
    void readLocalLyrics(track)
      .catch(() => undefined)
      .then((lyrics) => {
        lyricsCache.set(track.id, lyrics);
        if (!cancelled) setState({ key: track.id, lyrics });
      });

    return () => {
      cancelled = true;
    };
  }, [track]);

  if (!track) return undefined;
  if (lyricsCache.has(track.id)) return lyricsCache.get(track.id);
  return state.key === track.id ? state.lyrics : undefined;
}
