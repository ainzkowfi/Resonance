import type { Track } from '../types/track';

export type TrackOverrides = Partial<Pick<Track, 'title' | 'artist' | 'album'>>;

export interface LibraryFilter {
  /** URIs removed from the list without touching the disk. */
  hidden: string[];
  /** Tracks shorter than this many seconds are left out. Zero disables it. */
  minDuration: number;
  /** Display edits keyed by URI, applied on top of the scanned tags. */
  overrides: Record<string, TrackOverrides>;
}

export const EMPTY_FILTER: LibraryFilter = { hidden: [], minDuration: 0, overrides: {} };

export function applyLibraryFilter(tracks: Track[], filter: LibraryFilter): Track[] {
  const hidden = new Set(filter.hidden);
  return tracks
    .filter((track) => !hidden.has(track.uri) && track.duration >= filter.minDuration)
    .map((track) => {
      const patch = filter.overrides[track.uri];
      return patch ? { ...track, ...patch } : track;
    });
}
