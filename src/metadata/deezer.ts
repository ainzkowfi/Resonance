import { deezerQueue, fetchJson } from '../lib/http';
import { parseYear } from '../lib/format';
import type { Track } from '../types/track';

/**
 * Deezer — the richest keyless catalogue metadata: BPM, ReplayGain, ISRC,
 * explicit flags, contributor lists, and 1000x1000 cover art.
 *
 * Caveat: Deezer's CORS allowlist means this only works from a native app
 * (React Native's fetch sends no Origin header), not from Expo Web.
 */

const BASE = 'https://api.deezer.com';

export interface DeezerArtist {
  id: number;
  name: string;
  picture?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  nb_album?: number;
  nb_fan?: number;
  type?: string;
}

export interface DeezerAlbum {
  id: number;
  title: string;
  cover?: string;
  cover_small?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  md5_image?: string;
  release_date?: string;
}

export interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  isrc?: string;
  duration: number;
  rank?: number;
  explicit_lyrics?: boolean;
  preview?: string;
  md5_image?: string;
  track_position?: number;
  disk_number?: number;
  release_date?: string;
  bpm?: number;
  gain?: number;
  artist: DeezerArtist;
  album?: DeezerAlbum;
  contributors?: DeezerArtist[];
}

interface DeezerList<T> {
  data: T[];
  total?: number;
  next?: string;
}

export async function searchDeezer(query: string, limit = 10): Promise<DeezerTrack[]> {
  const url = `${BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const data = await deezerQueue.run(() => fetchJson<DeezerList<DeezerTrack>>(url, { timeoutMs: 8000 }));
  return data.data ?? [];
}

export async function getDeezerTrack(id: number): Promise<DeezerTrack | undefined> {
  try {
    return await deezerQueue.run(() => fetchJson<DeezerTrack>(`${BASE}/track/${id}`, { timeoutMs: 8000 }));
  } catch {
    return undefined;
  }
}

export async function getDeezerArtist(id: number): Promise<DeezerArtist | undefined> {
  try {
    return await deezerQueue.run(() => fetchJson<DeezerArtist>(`${BASE}/artist/${id}`, { timeoutMs: 8000 }));
  } catch {
    return undefined;
  }
}

/** Artists that listeners also listen to. */
export async function getRelatedArtists(artistId: number): Promise<DeezerArtist[]> {
  try {
    const data = await deezerQueue.run(() =>
      fetchJson<DeezerList<DeezerArtist>>(`${BASE}/artist/${artistId}/related`, { timeoutMs: 8000 }),
    );
    return data.data ?? [];
  } catch {
    return [];
  }
}

/** Most-played tracks for an artist. */
export async function getArtistTopTracks(artistId: number, limit = 10): Promise<DeezerTrack[]> {
  try {
    const data = await deezerQueue.run(() =>
      fetchJson<DeezerList<DeezerTrack>>(`${BASE}/artist/${artistId}/top?limit=${limit}`, {
        timeoutMs: 8000,
      }),
    );
    return data.data ?? [];
  } catch {
    return [];
  }
}

export function toCatalogTrack(t: DeezerTrack): Track {
  return {
    id: `catalog:deezer:${t.id}`,
    source: 'catalog',
    uri: t.preview ?? '',
    title: t.title_short || t.title,
    artist: t.artist?.name ?? 'Unknown Artist',
    album: t.album?.title,
    artwork: t.album?.cover_xl ?? t.artist?.picture_xl,
    duration: t.duration ?? 0,
    year: parseYear(t.release_date),
    trackNumber: t.track_position,
    discNumber: t.disk_number,
    isrc: t.isrc,
    bpm: t.bpm,
    gain: t.gain,
    isPreview: Boolean(t.preview),
  };
}
