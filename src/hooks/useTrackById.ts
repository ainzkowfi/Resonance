import { useEffect, useState } from 'react';

import { lookupTrack, toCatalogTrack } from '../metadata/itunes';
import { useLibraryStore } from '../store/library';
import { usePlayerStore } from '../store/player';
import type { Track } from '../types/track';

/**
 * Resolve a route id to a track.
 *
 * Ids are `local:<assetId>` or `catalog:<itunesTrackId>`; local and queued
 * tracks are already in memory, catalog tracks are looked up once.
 */
export function useTrackById(id: string) {
  const [state, setState] = useState<{ key: string; track?: Track }>({ key: '' });

  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      const queued = usePlayerStore.getState().queue.find((item) => item.id === id);
      const local = useLibraryStore.getState().tracks.find((item) => item.id === id);
      let found: Track | undefined = queued ?? local;

      if (!found && id.startsWith('catalog:')) {
        try {
          const itunesTrack = await lookupTrack(Number(id.slice('catalog:'.length)));
          found = itunesTrack ? toCatalogTrack(itunesTrack) : undefined;
        } catch {
          found = undefined;
        }
      }

      if (!cancelled) setState({ key: id, track: found });
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const loading = state.key !== id;
  return { track: loading ? undefined : state.track, loading };
}
