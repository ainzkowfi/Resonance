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
  const minDuration = Number.isFinite(filter.minDuration) ? filter.minDuration : 0;
  return tracks
    .filter((track) => !hidden.has(track.uri) && track.duration >= minDuration)
    .map((track) => {
      const patch = filter.overrides?.[track.uri];
      return patch ? { ...track, ...patch } : track;
    });
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : fallback;

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Anything read back from storage, made safe to render.
 *
 * The library cache and the persisted queue were written by whatever version of
 * the app ran last, so every field has to be assumed wrong: the library screen
 * calls `localeCompare` on `artist`, the track screen calls `toFixed` on `gain`,
 * and `id` is the list key. A single missing string was a TypeError that took
 * the screen down, so records are checked once here instead of at each of those
 * call sites.
 */
export function sanitizeTracks(value: unknown): Track[] {
  if (!Array.isArray(value)) return [];
  const tracks: Track[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== 'string' || raw.id.length === 0) continue;
    if (typeof raw.uri !== 'string' || raw.uri.length === 0) continue;

    tracks.push({
      id: raw.id,
      uri: raw.uri,
      source: 'local',
      title: text(raw.title, raw.uri),
      artist: text(raw.artist, 'Unknown Artist'),
      album: optionalText(raw.album),
      albumArtist: optionalText(raw.albumArtist),
      artwork: optionalText(raw.artwork),
      duration: optionalNumber(raw.duration) ?? 0,
      genre: optionalText(raw.genre),
      composer: optionalText(raw.composer),
      conductor: optionalText(raw.conductor),
      lyricist: optionalText(raw.lyricist),
      publisher: optionalText(raw.publisher),
      copyright: optionalText(raw.copyright),
      comment: optionalText(raw.comment),
      grouping: optionalText(raw.grouping),
      encoder: optionalText(raw.encoder),
      year: optionalNumber(raw.year),
      trackNumber: optionalNumber(raw.trackNumber),
      discNumber: optionalNumber(raw.discNumber),
      isrc: optionalText(raw.isrc),
      bpm: optionalNumber(raw.bpm),
      gain: optionalNumber(raw.gain),
      lyricsUri: optionalText(raw.lyricsUri),
    });
  }

  return tracks;
}
