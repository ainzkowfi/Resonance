import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { getAssetsAsync, requestPermissionsAsync, type Asset } from 'expo-media-library/legacy';

import { fromBase64 } from '../lib/bytes';
import { isExcluded } from '../lib/folderExclusions';
import { stableId } from '../lib/format';
import { parseFilename } from '../lib/id3';
import {
  basename,
  findCoverSidecar,
  findLyricsSidecar,
  looksLikeLrc,
  stemOf,
} from '../lib/lyrics';
import {
  declaredTagBytes,
  headWindowBytes,
  isAudioFilename,
  MAX_TAG_BYTES,
  parseDuration,
  parseTags,
  sniffFormat,
  type AudioFormat,
  type TrackTags,
} from '../lib/tags';
import type { Lyrics, Track } from '../types/track';

/**
 * Local library scanning.
 *
 * Two sources, because they fail in different places:
 *
 * - A **folder tree** the user grants through the system picker (Storage
 *   Access Framework). MediaStore only indexes audio, so this is the only way
 *   to see the `.lrc` and `cover.jpg` files sitting next to the songs — which
 *   is exactly what a downloaded library looks like.
 * - **MediaStore**, as a fallback, for songs already indexed by the system.
 *
 * Tags are read straight out of the bytes (`lib/tags`), so the container
 * decides what we can read — mp3, flac, m4a, ogg/opus, wav, aiff and ape/wv
 * all go through the same path.
 */

/**
 * First window read per file. Large enough for the tag block of most files and
 * an order of magnitude smaller than the old fixed 512 KB read; grown only when
 * the container says it must be.
 */
const INITIAL_HEAD_BYTES = 64 * 1024;
/** Ceiling for a single tag read — the window every file used to be read at. */
const HEAD_BYTES = MAX_TAG_BYTES;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const TAIL_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 6000;
const MAX_DEPTH = 8;
const PAGE_SIZE = 200;
/**
 * Ceiling for the no-seek fallback, where the whole file has to be read.
 *
 * `FileHandle` is how a tag window stays small, but a provider that refuses
 * random access leaves only `bytes()` — which allocates the entire track in JS
 * memory. A folder of FLACs read that way is an out-of-memory crash, so past
 * this size the read is abandoned instead. The track still lists, by filename.
 */
const MAX_FALLBACK_BYTES = 8 * 1024 * 1024;

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export async function requestAudioPermission(): Promise<PermissionState> {
  try {
    const { status } = await requestPermissionsAsync(false, ['audio']);
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'undetermined';
  } catch {
    return 'unsupported';
  }
}

/** Opens the system folder picker. Returns the granted tree URI. */
export async function pickMusicFolder(): Promise<string | undefined> {
  try {
    const directory = await Directory.pickDirectoryAsync();
    return directory.uri;
  } catch {
    return undefined;
  }
}

export interface ScanOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** Folder tree to scan instead of MediaStore. */
  folder?: string;
  /** Folders whose contents are skipped entirely, including subfolders. */
  excluded?: readonly string[];
}

interface ScanEntry {
  uri: string;
  name: string;
  lyricsUri?: string;
  coverUri?: string;
  knownDuration?: number;
}

interface DirEntry {
  uri: string;
  name: string;
  isDirectory: boolean;
}

function listDirectory(uri: string): DirEntry[] | undefined {
  try {
    return new Directory(uri).list().map((item) => {
      const isDirectory = item instanceof Directory;
      return {
        uri: item.uri,
        name: isDirectory ? (item as Directory).name : basename(item.uri),
        isDirectory,
      };
    });
  } catch {
    return undefined;
  }
}

interface ByteWindow {
  data: Uint8Array;
  size: number;
}

async function readHead(uri: string, maxBytes: number): Promise<ByteWindow | undefined> {
  let handle: ReturnType<File['open']> | undefined;
  try {
    handle = new File(uri).open(FileMode.ReadOnly);
    const size = handle.size ?? 0;
    const length = size > 0 ? Math.min(maxBytes, size) : maxBytes;
    return { data: await handle.readBytes(length), size };
  } catch {
    // Some MediaStore providers do not expose random access. Fall back to the
    // regular async file read for those URIs.
  } finally {
    handle?.close();
  }
  try {
    const file = new File(uri);
    const size = file.exists ? (file.size ?? 0) : 0;
    if (size > MAX_FALLBACK_BYTES) return undefined;
    const all = await file.bytes();
    if (all.length > MAX_FALLBACK_BYTES) return undefined;
    return { data: all.length > maxBytes ? all.subarray(0, maxBytes) : all, size: all.length };
  } catch {
    return undefined;
  }
}

/** Reads the end of the file, where ID3v1, APEv2 and Ogg granules live. */
async function readTail(uri: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const handle = new File(uri).open(FileMode.ReadOnly);
    try {
      const size = handle.size ?? 0;
      if (size <= 0) return undefined;
      const start = Math.max(0, size - maxBytes);
      handle.offset = start;
      return await handle.readBytes(size - start);
    } finally {
      handle.close();
    }
  } catch {
    try {
      const file = new File(uri);
      const size = file.exists ? (file.size ?? 0) : 0;
      if (size > MAX_FALLBACK_BYTES) return undefined;
      const all = await file.bytes();
      if (all.length > MAX_FALLBACK_BYTES) return undefined;
      return all.length > maxBytes ? all.subarray(all.length - maxBytes) : all;
    } catch {
      return undefined;
    }
  }
}

interface ParsedFile {
  tags: TrackTags;
  format: AudioFormat;
  duration?: number;
}

/** Return the next FLAC metadata boundary when the current read cuts a block. */
function nextFlacMetadataReadSize(bytes: Uint8Array): number | undefined {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') return undefined;

  let cursor = 4;
  while (cursor < MAX_METADATA_BYTES) {
    if (cursor + 4 > bytes.length) return cursor + 4;

    const header = bytes[cursor];
    const length = (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3];
    const end = cursor + 4 + length;
    if (end > MAX_METADATA_BYTES) return undefined;
    if (end > bytes.length) return end;

    cursor = end;
    if ((header & 0x80) !== 0) return undefined;
  }

  return undefined;
}

/**
 * Reads the smallest window that holds the file's tags.
 *
 * Scanning used to read 512 KB of every file up front, which is gigabytes of
 * I/O for a large library. An ID3v2 file states where its tag ends, so the
 * common case now reads the tag and stops; FLAC declares its metadata block by
 * block, which is walked here rather than guessed at. The ID3 window is capped
 * at what it used to be, so it never grows beyond it.
 *
 * `ceiling` bounds the FLAC walk: a full scan may read cover art to cache it,
 * while a lyrics lookup only needs the comment block.
 */
async function readHeadWindow(
  uri: string,
  ceiling = MAX_METADATA_BYTES,
): Promise<ByteWindow | undefined> {
  let head = await readHead(uri, INITIAL_HEAD_BYTES);
  if (!head) return undefined;

  const wanted = headWindowBytes(head.data.length, declaredTagBytes(head.data), head.size);
  if (wanted > head.data.length) {
    const expanded = await readHead(uri, wanted);
    if (expanded && expanded.data.length > head.data.length) head = expanded;
  }

  if (sniffFormat(head.data) !== 'flac') return head;

  let required = nextFlacMetadataReadSize(head.data);
  while (required && required > head.data.length && required <= ceiling) {
    const expanded = await readHead(uri, Math.min(required, ceiling));
    if (!expanded || expanded.data.length <= head.data.length) break;
    head = expanded;
    required = nextFlacMetadataReadSize(head.data);
  }
  return head;
}

async function readTrackFile(uri: string): Promise<ParsedFile> {
  let head = await readHeadWindow(uri);
  if (!head) return { tags: {}, format: 'unknown' };

  let format = sniffFormat(head.data);
  let tags = parseTags(head.data);

  // MP4 keeps `moov` wherever it likes, RIFF `LIST` chunks can trail the audio,
  // and a Vorbis comment can sit past a large picture. None of those declare a
  // size at the start, so fall back to the old window before giving up on them.
  // MP3 and FLAC are left out on purpose: their tag blocks are declared at the
  // start (FLAC's walked block by block above), so a missing title there means
  // there is nothing further along, and a second read would only cost time.
  const mayTagLater =
    format === 'mp4' || format === 'ogg' || format === 'wav' || format === 'aiff' || format === 'unknown';
  if (!tags.title && mayTagLater && head.data.length < HEAD_BYTES && head.size > head.data.length) {
    const expanded = await readHead(uri, Math.min(HEAD_BYTES, head.size));
    if (expanded && expanded.data.length > head.data.length) {
      head = expanded;
      format = sniffFormat(head.data);
      tags = parseTags(head.data);
    }
  }

  let tail: Uint8Array | undefined;

  const wantsTail =
    !tags.title || format === 'ape' || format === 'wv' || format === 'unknown' || format === 'ogg';
  if (wantsTail) {
    tail = await readTail(uri, TAIL_BYTES);
    if (tail) tags = parseTags(head.data, tail);
  }

  return { tags, format, duration: parseDuration(head.data, format, head.size, tail) };
}

const artworkDirectory = (): Directory | undefined => {
  try {
    const directory = new Directory(Paths.cache, 'artwork');
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
    return directory;
  } catch {
    return undefined;
  }
};

const artworkName = (id: string) => id.replace(/[^a-z0-9]+/gi, '');

/**
 * Embedded art arrives as a data URI, which is far too big to persist in the
 * queue. Write it once into the cache directory and point at the file.
 */
async function cacheEmbeddedArtwork(id: string, dataUri?: string): Promise<string | undefined> {
  if (!dataUri) return undefined;
  const match = dataUri.match(/^data:([^;,]+);base64,([^]*)$/);
  if (!match) return undefined;
  if (match[2].length > Math.ceil((MAX_COVER_BYTES * 4) / 3)) return undefined;
  const mime = match[1];
  const extension = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  try {
    const directory = artworkDirectory();
    if (!directory) throw new Error('no cache directory');
    const file = new File(directory, `${artworkName(id)}.${extension}`);
    await file.write(fromBase64(match[2]));
    return file.uri;
  } catch {
    return dataUri.length <= 512 * 1024 ? dataUri : undefined;
  }
}

async function cacheCoverFile(coverUri: string, id: string): Promise<string | undefined> {
  try {
    const source = new File(coverUri);
    const bytes = await source.bytes();
    if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return undefined;
    const directory = artworkDirectory();
    if (!directory) return undefined;
    const extension = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'png' : 'jpg';
    const file = new File(directory, `${artworkName(id)}.${extension}`);
    await file.write(bytes);
    return file.uri;
  } catch {
    return undefined;
  }
}

function toLyrics(text?: string): Lyrics | undefined {
  const value = text?.trim();
  if (!value || value.length < 8) return undefined;
  return looksLikeLrc(value)
    ? { synced: value, plain: value, source: 'local' }
    : { plain: value, source: 'local' };
}

/**
 * A length the library filter can compare.
 *
 * MediaStore reports durations it does not always know. `Math.round(NaN)` is
 * NaN, and NaN fails `duration >= 0` — so one missing duration removed the
 * track from the list at every short-track setting, including "off". An unknown
 * length is 0 here: it sorts and displays as unknown, and stays visible.
 */
function wholeSeconds(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

async function buildTrack(entry: ScanEntry): Promise<Track | undefined> {
  const parsed = await readTrackFile(entry.uri);
  const fromName = parseFilename(entry.name);
  const tags = parsed.tags;
  const id = stableId('local:', entry.uri);

  let artwork = await cacheEmbeddedArtwork(id, tags.artwork);
  if (!artwork && entry.coverUri) artwork = await cacheCoverFile(entry.coverUri, id);

  return {
    id,
    source: 'local',
    uri: entry.uri,
    title: tags.title ?? fromName.title ?? stemOf(entry.name) ?? entry.name,
    artist: tags.artist ?? fromName.artist ?? tags.albumArtist ?? 'Unknown Artist',
    album: tags.album,
    albumArtist: tags.albumArtist,
    artwork,
    duration: wholeSeconds(entry.knownDuration ?? parsed.duration),
    genre: tags.genre,
    composer: tags.composer,
    conductor: tags.conductor,
    lyricist: tags.lyricist,
    publisher: tags.publisher,
    copyright: tags.copyright,
    comment: tags.comment,
    grouping: tags.grouping,
    encoder: tags.encoder,
    year: tags.year,
    trackNumber: tags.trackNumber,
    discNumber: tags.discNumber,
    isrc: tags.isrc,
    bpm: tags.bpm,
    gain: tags.gain,
    lyricsUri: entry.lyricsUri,
  };
}

function sortTracks(tracks: Track[]): Track[] {
  return tracks.sort(
    (a, b) =>
      a.artist.localeCompare(b.artist) ||
      (a.album ?? '').localeCompare(b.album ?? '') ||
      (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
      (a.trackNumber ?? 0) - (b.trackNumber ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

async function collectEntries(
  folderUri: string,
  signal?: AbortSignal,
  excluded: readonly string[] = [],
): Promise<ScanEntry[]> {
  const entries: ScanEntry[] = [];
  // Excluding the scanned folder itself leaves nothing to find.
  if (isExcluded(folderUri, excluded)) return entries;
  const queue: { uri: string; depth: number }[] = [{ uri: folderUri, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0 && entries.length < MAX_FILES) {
    if (signal?.aborted) break;
    const next = queue.shift();
    if (!next || visited.has(next.uri)) continue;
    visited.add(next.uri);

    const listing = listDirectory(next.uri);
    if (!listing) continue;

    const files = listing.filter((item) => !item.isDirectory);
    const names = files.map((item) => item.name);
    const coverName = findCoverSidecar(names);
    const coverUri = coverName ? files.find((item) => item.name === coverName)?.uri : undefined;

    for (const item of listing) {
      if (item.isDirectory) {
        // An excluded folder is never walked, so nothing inside it is parsed.
        if (isExcluded(item.uri, excluded)) continue;
        if (next.depth < MAX_DEPTH) queue.push({ uri: item.uri, depth: next.depth + 1 });
        continue;
      }
      if (!isAudioFilename(item.name)) continue;

      const lyricsName = findLyricsSidecar(names, item.name);
      entries.push({
        uri: item.uri,
        name: item.name,
        lyricsUri: lyricsName ? files.find((file) => file.name === lyricsName)?.uri : undefined,
        coverUri,
      });
      if (entries.length >= MAX_FILES) break;
    }
  }

  return entries;
}

async function parseEntries(entries: ScanEntry[], options: ScanOptions): Promise<Track[]> {
  const tracks: Track[] = [];
  for (let index = 0; index < entries.length; index++) {
    if (options.signal?.aborted) break;
    const track = await buildTrack(entries[index]);
    if (track) tracks.push(track);
    options.onProgress?.(index + 1, entries.length);
  }
  return sortTracks(tracks);
}

export async function scanFolder(folderUri: string, options: ScanOptions = {}): Promise<Track[]> {
  const entries = await collectEntries(folderUri, options.signal, options.excluded);
  return parseEntries(entries, options);
}

/**
 * Cheap pass for the folder watcher: lists the tree again and parses only the
 * files the library has never seen. Returns `undefined` when the file set is
 * unchanged, so the caller can skip the re-render.
 */
export async function syncFolder(
  folderUri: string,
  previous: Track[],
  excluded: readonly string[] = [],
): Promise<Track[] | undefined> {
  const entries = await collectEntries(folderUri, undefined, excluded);
  const known = new Set(previous.map((track) => track.uri));
  const onDisk = new Set(entries.map((entry) => entry.uri));
  const kept = previous.filter((track) => onDisk.has(track.uri));

  const added: Track[] = [];
  for (const entry of entries) {
    if (known.has(entry.uri)) continue;
    const track = await buildTrack(entry);
    if (track) added.push(track);
  }

  if (added.length === 0 && kept.length === previous.length) return undefined;
  return sortTracks([...kept, ...added]);
}

function probeSidecar(audioUri: string): string | undefined {
  const stem = audioUri.replace(/\.[a-z0-9]{2,5}$/i, '');
  for (const extension of ['.lrc', '.LRC', '.txt']) {
    const candidate = `${stem}${extension}`;
    try {
      if (new File(candidate).exists) return candidate;
    } catch {
      // A missing sidecar is the normal case, not an error.
    }
  }
  return undefined;
}

export async function scanMediaStore(options: ScanOptions = {}): Promise<Track[]> {
  const assets: Asset[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  try {
    for (;;) {
      const page = await getAssetsAsync({ mediaType: 'audio', first: PAGE_SIZE, after: cursor });
      for (const asset of page.assets) {
        // Pages can overlap; an asset is only worth reading once.
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        assets.push(asset);
      }
      if (!page.hasNextPage || assets.length >= MAX_FILES) break;
      // A provider that repeats its cursor would otherwise page forever,
      // growing this array until the process runs out of memory.
      const next = page.endCursor;
      if (!next || next === cursor) break;
      cursor = next;
    }
  } catch (error) {
    // Half a library is better than a screen that never leaves "Scanning…".
    if (assets.length === 0) throw error;
  }

  const entries: ScanEntry[] = assets.slice(0, MAX_FILES).map((asset) => ({
    uri: asset.uri,
    name: asset.filename ?? basename(asset.uri),
    lyricsUri: probeSidecar(asset.uri),
    knownDuration: asset.duration ?? undefined,
  }));

  return parseEntries(entries, options);
}

export async function scanLocalLibrary(options: ScanOptions = {}): Promise<Track[]> {
  if (options.folder) return scanFolder(options.folder, options);
  return scanMediaStore(options);
}

/**
 * Lyrics for a local track: the `.lrc`/`.txt` beside the file wins, then
 * whatever is embedded in the tag.
 */
export async function readLocalLyrics(track: Track): Promise<Lyrics | undefined> {
  if (track.lyricsUri) {
    try {
      const fromFile = toLyrics(await new File(track.lyricsUri).text());
      if (fromFile) return fromFile;
    } catch {
      // Fall through to the embedded tag.
    }
  }

  if (track.source !== 'local') return undefined;

  const head = await readHeadWindow(track.uri, HEAD_BYTES);
  if (!head) return undefined;
  return toLyrics(parseTags(head.data).lyrics);
}

/** Distinct albums in the library, for the album grid. */
export function groupAlbums(tracks: Track[]) {
  const albums = new Map<
    string,
    { key: string; name: string; artist: string; artwork?: string; tracks: Track[] }
  >();
  for (const t of tracks) {
    const key = `${t.artist}::${t.album ?? t.title}`;
    const existing = albums.get(key);
    if (existing) {
      existing.tracks.push(t);
      existing.artwork ??= t.artwork;
    } else {
      albums.set(key, {
        key,
        name: t.album ?? t.title,
        artist: t.artist,
        artwork: t.artwork,
        tracks: [t],
      });
    }
  }
  return Array.from(albums.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function groupArtists(tracks: Track[]) {
  const artists = new Map<string, { name: string; artwork?: string; tracks: Track[] }>();
  for (const t of tracks) {
    const existing = artists.get(t.artist);
    if (existing) {
      existing.tracks.push(t);
      existing.artwork ??= t.artwork;
    } else {
      artists.set(t.artist, { name: t.artist, artwork: t.artwork, tracks: [t] });
    }
  }
  return Array.from(artists.values()).sort((a, b) => a.name.localeCompare(b.name));
}
