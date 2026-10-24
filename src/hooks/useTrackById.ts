import { useLibraryStore } from '../store/library';
import { usePlayerStore } from '../store/player';

/** Resolve a track details route from the local library or current queue. */
export function useTrackById(id: string) {
  const queuedTrack = usePlayerStore((state) => state.queue.find((item) => item.id === id));
  const libraryTrack = useLibraryStore((state) => state.entries.find((item) => item.id === id));
  return { track: queuedTrack ?? libraryTrack, loading: false };
}
