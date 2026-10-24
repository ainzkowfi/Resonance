import { fetchJson, itunesQueue } from '../lib/http';
import { parseYear } from '../lib/format';
import type { Track } from '../types/track';

/**
 * iTunes Search API — the workhorse.
 *
 * No key, CORS `*`, and a single call returns title, artist, album, genre,
 * duration, release date, and cover art. The `previewUrl` is a 30 second
 * AAC excerpt, which is enough to make a catalog entry audible.
 */

const BASE = 'https://itunes.apple.com';

export interface ITunesTrack {
  trackId: number;
  collectionId: number;
  artistId: number;
  artistName: string;
  collectionName: string;
  trackName: string;
  artworkUrl30?: string;
  artworkUrl60?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  primaryGenreName?: string;
  trackTimeMillis?: number;
  releaseDate?: string;
  trackNumber?: number;
  discNumber?: number;
  collectionExplicitness?: string;
  trackExplicitness?: string;
  country?: string;
}

interface ITunesResponse {
  resultCount: number;
  results: ITunesTrack[];
}

/** iTunes ships a 100x100 URL; the same path segment accepts 600x600. */
export function upscaleArtwork(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1');
}

export async function searchCatalog(term: string, limit = 25): Promise<ITunesTrack[]> {
  const url = `${BASE}/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`;
  const data = await itunesQueue.run(() => fetchJson<ITunesResponse>(url, { timeoutMs: 8000 }));
  return data.results ?? [];
}

export async function lookupTrack(trackId: number): Promise<ITunesTrack | undefined> {
  const url = `${BASE}/lookup?id=${trackId}&entity=song`;
  const data = await itunesQueue.run(() => fetchJson<ITunesResponse>(url, { timeoutMs: 8000 }));
  return data.results?.[0];
}

/** Rank candidates so the best match for `artist`/`title` comes first. */
export function pickBestMatch(
  results: ITunesTrack[],
  artist: string,
  title: string,
): ITunesTrack | undefined {
  if (results.length === 0) return undefined;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const wantArtist = norm(artist);
  const wantTitle = norm(title);
  let best = results[0];
  let bestScore = -1;
  for (const r of results) {
    const ra = norm(r.artistName);
    const rt = norm(r.trackName);
    let score = 0;
    if (rt === wantTitle) score += 60;
    else if (rt.includes(wantTitle) || wantTitle.includes(rt)) score += 35;
    else if (rt.split(' ').some((w) => w.length > 3 && rt.includes(w))) score += 12;
    if (ra === wantArtist) score += 40;
    else if (ra.includes(wantArtist) || wantArtist.includes(ra)) score += 20;
    else if (ra.split(' ').some((w) => w.length > 3 && ra.includes(w))) score += 8;
    if (r.previewUrl) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

export function toCatalogTrack(it: ITunesTrack): Track {
  return {
    id: `catalog:${it.trackId}`,
    source: 'catalog',
    uri: it.previewUrl ?? '',
    title: it.trackName,
    artist: it.artistName,
    album: it.collectionName,
    artwork: upscaleArtwork(it.artworkUrl100),
    duration: it.trackTimeMillis ? Math.round(it.trackTimeMillis / 1000) : 0,
    genre: it.primaryGenreName,
    year: parseYear(it.releaseDate),
    trackNumber: it.trackNumber,
    discNumber: it.discNumber,
    isPreview: Boolean(it.previewUrl),
  };
}
