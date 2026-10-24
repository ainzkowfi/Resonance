import { fetchJson, lrclibQueue } from '../lib/http';
import type { Lyrics } from '../types/track';

/**
 * LRCLIB — the best free synced-lyrics source (no key, CORS `*`).
 *
 * Two traps we have to defend against, both verified against the live API:
 *  1. `/api/get` can return a seeded placeholder fixture whose `duration`
 *     matches but whose lyrics are literally the word "probe". We validate the
 *     returned artist/title/duration and reject trivial text.
 *  2. `/api/get` occasionally misses a record that `/api/search` finds, so we
 *     search first and fall back to get.
 */

const BASE = 'https://lrclib.net/api';

export interface LrclibRecord {
  id: number;
  name: string;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  hasWordSync?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
  lyricsfile?: string;
}

/** Placeholder fixtures the API sometimes returns for seeded records. */
const PLACEHOLDER = /^(probe|audit[-_ ]?probe|lrcget_audit_probe_do_not_use|test)$/i;

function isTrivial(text?: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 12) return true;
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  return PLACEHOLDER.test(firstLine);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function score(record: LrclibRecord, artist: string, title: string, duration?: number): number {
  let s = 0;
  const ra = normalize(record.artistName);
  const rt = normalize(record.trackName);
  const wa = normalize(artist);
  const wt = normalize(title);
  if (rt === wt) s += 60;
  else if (rt.includes(wt) || wt.includes(rt)) s += 30;
  if (ra === wa) s += 40;
  else if (ra.includes(wa) || wa.includes(ra)) s += 20;
  if (duration && record.duration && Math.abs(record.duration - duration) <= 2) s += 50;
  else if (duration && record.duration && Math.abs(record.duration - duration) <= 6) s += 20;
  if (record.syncedLyrics) s += 15;
  if (record.instrumental) s -= 100;
  if (isTrivial(record.plainLyrics) && isTrivial(record.syncedLyrics)) s -= 100;
  return s;
}

export async function fetchLyrics(
  artist: string,
  title: string,
  album?: string,
  duration?: number,
): Promise<Lyrics | undefined> {
  const searchUrl =
    `${BASE}/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
  let candidates: LrclibRecord[] = [];
  try {
    candidates = await lrclibQueue.run(() =>
      fetchJson<LrclibRecord[]>(searchUrl, { timeoutMs: 8000, retries: 1 }),
    );
  } catch {
    candidates = [];
  }

  if (candidates.length === 0) {
    const getUrl =
      `${BASE}/get?artist_name=${encodeURIComponent(artist)}` +
      `&track_name=${encodeURIComponent(title)}` +
      (album ? `&album_name=${encodeURIComponent(album)}` : '') +
      (duration ? `&duration=${Math.round(duration)}` : '');
    try {
      const one = await lrclibQueue.run(() =>
        fetchJson<LrclibRecord>(getUrl, { timeoutMs: 8000, retries: 0 }),
      );
      candidates = [one];
    } catch {
      return undefined;
    }
  }

  const best = candidates
    .map((c) => ({ c, s: score(c, artist, title, duration) }))
    .sort((a, b) => b.s - a.s)[0];

  if (!best || best.s <= 0) return undefined;
  const record = best.c;
  const synced = record.syncedLyrics && !isTrivial(record.syncedLyrics) ? record.syncedLyrics : undefined;
  const plain = record.plainLyrics && !isTrivial(record.plainLyrics) ? record.plainLyrics : undefined;
  if (!synced && !plain) return undefined;

  return { synced, plain, source: 'lrclib' };
}

/**
 * lyrics.ovh — plain-text fallback. No key, but it is frequently slow and
 * times out roughly half the time, so the timeout is short and we only try it
 * when LRCLIB came up empty.
 */
export async function fetchPlainLyrics(artist: string, title: string): Promise<Lyrics | undefined> {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
  try {
    const data = await fetchJson<{ lyrics?: string }>(url, { timeoutMs: 6000, retries: 1 });
    const text = data.lyrics?.trim();
    if (!text || text.length < 12) return undefined;
    return { plain: text, source: 'lyrics.ovh' };
  } catch {
    return undefined;
  }
}
