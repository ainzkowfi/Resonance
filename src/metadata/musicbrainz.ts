import { fetchJson, musicBrainzQueue } from '../lib/http';
import { parseYear } from '../lib/format';

/**
 * MusicBrainz — free, open, and the only keyless source of fine-grained
 * genres, artist disambiguation, and real label/release metadata.
 *
 * Two hard requirements: a descriptive User-Agent (already set in the http
 * layer) and <= 1 request/second, which the `musicBrainzQueue` enforces.
 */

const BASE = 'https://musicbrainz.org/ws/2';

export interface MBGenre {
  name: string;
  id: string;
  count?: number;
}

export interface MBArtist {
  id: string;
  name: string;
  sortname?: string;
  disambiguation?: string;
  type?: string;
  country?: string;
  area?: { name?: string };
  'life-span'?: { begin?: string; end?: string };
  genres?: MBGenre[];
  tags?: { name: string; count?: number }[];
  relations?: {
    type: string;
    'release-group'?: { id: string; 'first-release-date'?: string; title?: string };
    artist?: { id: string; name: string };
  }[];
}

export interface MBRecording {
  id: string;
  title: string;
  length?: number;
  score?: number;
  disambiguation?: string;
  'first-release-date'?: string;
  genres?: MBGenre[];
  tags?: { name: string; count?: number }[];
  'artist-credit'?: { name?: string; artist?: MBArtist }[];
  releases?: {
    id: string;
    title?: string;
    date?: string;
    country?: string;
    status?: string;
    'label-info'?: { label?: { name?: string }; 'catalog-number'?: string }[];
    'release-group'?: { id: string; 'primary-type'?: string; 'first-release-date'?: string };
    media?: { format?: string; track?: { id: string; title: string; number?: string }[] }[];
  }[];
}

interface MBRecordingSearch {
  recordings: MBRecording[];
  count: number;
}

export async function searchRecording(
  recording: string,
  artist: string,
  limit = 5,
): Promise<MBRecording[]> {
  const query = `recording:"${recording.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
  const url = `${BASE}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
  const data = await musicBrainzQueue.run(() =>
    fetchJson<MBRecordingSearch>(url, { timeoutMs: 10000, retries: 1 }),
  );
  return data.recordings ?? [];
}

export async function getArtist(mbid: string): Promise<MBArtist | undefined> {
  try {
    return await musicBrainzQueue.run(() =>
      fetchJson<MBArtist>(`${BASE}/artist/${mbid}?fmt=json&inc=genres+tags`, { timeoutMs: 10000 }),
    );
  } catch {
    return undefined;
  }
}

export interface MBReleaseGroup {
  id: string;
  title?: string;
  'first-release-date'?: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'artist-credit'?: { name?: string; artist?: { id: string; name: string } }[];
}

export async function getReleaseGroup(mbid: string): Promise<MBReleaseGroup | undefined> {
  try {
    return await musicBrainzQueue.run(() =>
      fetchJson<MBReleaseGroup>(`${BASE}/release-group/${mbid}?fmt=json`, { timeoutMs: 10000 }),
    );
  } catch {
    return undefined;
  }
}

export interface CoverArt {
  front?: boolean;
  image: string;
  thumbnails?: Record<string, string>;
  types?: string[];
}

/**
 * Cover Art Archive.
 *
 * Every endpoint answers with a 307 to archive.org, so the JSON index only
 * appears after following the redirect. The returned image URLs are `http://`,
 * which Android's cleartext policy blocks, so they are rewritten to https.
 */
export async function getCoverArt(releaseMbid: string): Promise<CoverArt | undefined> {
  try {
    const data = await musicBrainzQueue.run(() =>
      fetchJson<{ images: CoverArt[] }>(`https://coverartarchive.org/release/${releaseMbid}`, {
        timeoutMs: 12000,
      }),
    );
    const front = data.images?.find((i) => i.front) ?? data.images?.[0];
    if (!front) return undefined;
    return {
      ...front,
      image: front.image.replace(/^http:\/\//, 'https://'),
      thumbnails: front.thumbnails
        ? Object.fromEntries(
            Object.entries(front.thumbnails).map(([k, v]) => [k, v.replace(/^http:\/\//, 'https://')]),
          )
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function firstReleaseYear(recording?: MBRecording): number | undefined {
  const dates = [
    recording?.['first-release-date'],
    recording?.releases?.[0]?.date,
    recording?.releases?.[0]?.['release-group']?.['first-release-date'],
  ];
  for (const d of dates) {
    const y = parseYear(d);
    if (y) return y;
  }
  return undefined;
}

export function releaseLabel(recording?: MBRecording): string | undefined {
  const info = recording?.releases?.[0]?.['label-info']?.[0];
  return info?.label?.name;
}
