import { readLocalLyrics } from '../library/local';
import { cacheGet, cacheSet } from '../lib/cache';
import { settle } from '../lib/http';
import type { Track, TrackInfo } from '../types/track';
import { fetchLyrics, fetchPlainLyrics } from './lrclib';
import {
  getArtistTopTracks,
  getRelatedArtists,
  searchDeezer,
  toCatalogTrack as deezerToTrack,
} from './deezer';
import { getArtist, getCoverArt, firstReleaseYear, releaseLabel, searchRecording } from './musicbrainz';
import { pickBestMatch, searchCatalog, toCatalogTrack as itunesToTrack, upscaleArtwork } from './itunes';

/**
 * The enrichment orchestrator.
 *
 * Every provider is optional: a track that nobody has a lyric for still gets
 * its artwork, genre, year, BPM, and similar songs. Providers run concurrently
 * and publish partial results through `onUpdate` so the UI fills in as answers
 * arrive rather than blocking on the slowest one.
 */

export interface EnrichOptions {
  onUpdate?: (info: TrackInfo) => void;
  signal?: AbortSignal;
}

function merge(base: TrackInfo, patch: Partial<TrackInfo>): TrackInfo {
  const merged: TrackInfo = {
    ...base,
    ...patch,
    track: { ...base.track, ...(patch.track ?? {}) },
    artistGenres: patch.artistGenres ?? base.artistGenres,
    similar: patch.similar ?? base.similar,
    providers: Array.from(new Set([...base.providers, ...(patch.providers ?? [])])),
  };
  return merged;
}

export async function enrichTrack(track: Track, options: EnrichOptions = {}): Promise<TrackInfo> {
  const { onUpdate } = options;
  const key = `enrich:${track.artist}|${track.title}|${track.duration}|${track.album ?? ''}|${track.lyricsUri ?? ''}`;

  const cached = await cacheGet<TrackInfo>(key);
  if (cached) {
    onUpdate?.(cached);
    return cached;
  }

  let state: TrackInfo = {
    track,
    similar: [],
    artistGenres: [],
    providers: [],
  };

  const publish = () => onUpdate?.(state);

  // --- Provider fan-out -------------------------------------------------
  const [itunesResult, deezerResult, lyricsResult, mbResult] = await settle([
    enrichFromItunes(track),
    enrichFromDeezer(track),
    enrichLyrics(track),
    enrichFromMusicBrainz(track),
  ] as const);

  if (itunesResult) {
    state = merge(state, itunesResult);
    publish();
  }
  if (deezerResult) {
    state = merge(state, deezerResult);
    publish();
  }
  if (lyricsResult?.lyrics) {
    state = merge(state, { lyrics: lyricsResult.lyrics, providers: [lyricsResult.source] });
    publish();
  }
  if (mbResult) {
    state = merge(state, mbResult);
    publish();
  }

  // Cover Art Archive needs a release MBID, so it can only run after
  // MusicBrainz has answered.
  if (state.releaseMbid) {
    const art = await getCoverArt(state.releaseMbid);
    const better = art?.thumbnails?.['500'] ?? art?.image;
    if (better && !state.track.artwork) {
      state = merge(state, { track: { ...state.track, artwork: better }, providers: ['coverart'] });
      publish();
    }
  }

  await cacheSet(key, state);
  return state;
}

async function enrichLyrics(track: Track): Promise<{ lyrics?: TrackInfo['lyrics']; source: string }> {
  // A downloaded library usually ships its own `.lrc`; never spend a network
  // round-trip on something already sitting next to the file.
  const local = await readLocalLyrics(track).catch(() => undefined);
  if (local) return { lyrics: local, source: 'local' };

  const primary = await fetchLyrics(track.artist, track.title, track.album, track.duration);
  if (primary) return { lyrics: primary, source: 'lrclib' };
  const fallback = await fetchPlainLyrics(track.artist, track.title);
  if (fallback) return { lyrics: fallback, source: 'lyrics.ovh' };
  return { source: '' };
}

async function enrichFromItunes(track: Track): Promise<Partial<TrackInfo> | undefined> {
  try {
    const term = `${track.artist} ${track.title}`;
    const results = await searchCatalog(term, 15);
    const best = pickBestMatch(results, track.artist, track.title);
    if (!best) return undefined;
    const candidate = itunesToTrack(best);
    return {
      track: {
        ...track,
        album: track.album ?? candidate.album,
        artwork: track.artwork ?? candidate.artwork,
        genre: track.genre ?? candidate.genre,
        year: track.year ?? candidate.year,
        duration: track.duration || candidate.duration,
      },
      albumYear: candidate.year,
      releaseDate: best.releaseDate,
      providers: ['itunes'],
    };
  } catch {
    return undefined;
  }
}

async function enrichFromDeezer(track: Track): Promise<Partial<TrackInfo> | undefined> {
  try {
    const matches = await searchDeezer(`${track.artist} ${track.title}`, 8);
    const best =
      matches.find(
        (m) =>
          m.title.toLowerCase().includes(track.title.toLowerCase().slice(0, 6)) ||
          track.title.toLowerCase().includes(m.title.toLowerCase().slice(0, 6)),
      ) ?? matches[0];
    if (!best) return undefined;

    const artistId = best.artist?.id;
    const [related, top] = await settle([
      artistId ? getRelatedArtists(artistId) : Promise.resolve([]),
      artistId ? getArtistTopTracks(artistId, 12) : Promise.resolve([]),
    ] as const);

    const similar: Track[] = [];
    const seen = new Set<string>();
    for (const rel of related ?? []) {
      for (const t of top ?? []) {
        if (t.artist?.id !== rel.id) continue;
        const converted = deezerToTrack(t);
        const dedupe = `${converted.artist}|${converted.title}`.toLowerCase();
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        similar.push(converted);
        if (similar.length >= 8) break;
      }
      if (similar.length >= 8) break;
    }

    const genres = new Set<string>();
    if (best.album?.title) genres.add(best.album.title);

    return {
      track: {
        ...track,
        artwork: track.artwork ?? best.album?.cover_xl ?? best.artist?.picture_xl,
        isrc: track.isrc ?? best.isrc,
        bpm: track.bpm ?? best.bpm,
        gain: track.gain ?? best.gain,
        album: track.album ?? best.album?.title,
        duration: track.duration || best.duration,
      },
      similar,
      providers: ['deezer'],
    };
  } catch {
    return undefined;
  }
}

async function enrichFromMusicBrainz(track: Track): Promise<Partial<TrackInfo> | undefined> {
  try {
    const recordings = await searchRecording(track.title, track.artist, 5);
    if (recordings.length === 0) return undefined;
    const best = recordings[0];
    const artist = best['artist-credit']?.[0]?.artist;

    const artistGenres = (artist?.genres ?? []).map((g) => g.name);
    const tags = (artist?.tags ?? []).map((t) => t.name);
    const allGenres = Array.from(new Set([...artistGenres, ...tags])).slice(0, 8);

    let bio: string | undefined;
    if (artist?.id) {
      const detail = await getArtist(artist.id);
      if (detail) bio = composeArtistBio(detail);
    }

    const releaseMbid = best.releases?.[0]?.id;

    return {
      track: {
        ...track,
        year: track.year ?? firstReleaseYear(best),
        album: track.album ?? best.releases?.[0]?.title,
      },
      artistGenres: allGenres,
      artistBio: bio,
      albumYear: firstReleaseYear(best),
      label: releaseLabel(best),
      artistMbid: artist?.id,
      releaseMbid,
      providers: ['musicbrainz'],
    };
  } catch {
    return undefined;
  }
}

/** MusicBrainz has no free-text biography, so we compose one from its facts. */
function composeArtistBio(artist: {
  name: string;
  type?: string;
  country?: string;
  area?: { name?: string };
  disambiguation?: string;
  'life-span'?: { begin?: string; end?: string };
  genres?: { name: string }[];
}): string | undefined {
  const parts: string[] = [];
  const kind = artist.type ? artist.type.toLowerCase() : null;
  const from = artist.area?.name ?? artist.country;
  if (kind && from) parts.push(`${artist.name} is a ${kind} from ${from}.`);
  else if (from) parts.push(`${artist.name} is an artist from ${from}.`);
  else if (kind) parts.push(`${artist.name} is a ${kind}.`);
  if (artist.disambiguation) parts.push(artist.disambiguation);
  if (artist['life-span']?.begin) {
    const span = artist['life-span'].end
      ? `${artist['life-span'].begin} – ${artist['life-span'].end}`
      : artist['life-span'].begin;
    parts.push(`Active ${span}.`);
  }
  if (artist.genres?.length) {
    parts.push(`Genres: ${artist.genres.slice(0, 4).map((g) => g.name).join(', ')}.`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

export { upscaleArtwork };
