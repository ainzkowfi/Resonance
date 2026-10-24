/**
 * ID3v2.2/2.3/2.4 and ID3v1 readers.
 *
 * `expo-media-library` exposes durations but never tags, and the community
 * tag-reading packages are either unmaintained or pin an incompatible
 * `expo-file-system`. The frames we actually need are a handful of text
 * frames plus the attached picture, so we read them ourselves.
 *
 * Only the header and the frames we care about are decoded; unknown frames are
 * skipped, and a malformed tag degrades to "no tags" rather than throwing.
 */

import {
  ascii,
  clean,
  dataUri,
  findNull,
  latin1,
  syncsafe,
  u32be,
  utf16,
  utf8,
} from './bytes.ts';

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  composer?: string;
  conductor?: string;
  lyricist?: string;
  publisher?: string;
  copyright?: string;
  comment?: string;
  grouping?: string;
  encoder?: string;
  genre?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  isrc?: string;
  bpm?: number;
  gain?: number;
  /** Unsynchronised lyrics embedded in the tag (USLT, or a TXXX:LYRICS frame). */
  lyrics?: string;
  /** Embedded cover art as a data URI. */
  artwork?: string;
}

const TEXT_FRAMES: Record<string, keyof Id3Tags> = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TPE2: 'albumArtist',
  TP2: 'albumArtist',
  TCOM: 'composer',
  TCM: 'composer',
  TPE3: 'conductor',
  TP3: 'conductor',
  TEXT: 'lyricist',
  TXT: 'lyricist',
  TPUB: 'publisher',
  TPB: 'publisher',
  TCOP: 'copyright',
  TCR: 'copyright',
  TIT1: 'grouping',
  TI1: 'grouping',
  TSSE: 'encoder',
  TSS: 'encoder',
  TALB: 'album',
  TAL: 'album',
  TCON: 'genre',
  TCO: 'genre',
  TDRC: 'year',
  TYER: 'year',
  TYE: 'year',
  TRCK: 'trackNumber',
  TRK: 'trackNumber',
  TPOS: 'discNumber',
  TPA: 'discNumber',
  TSRC: 'isrc',
  TRC: 'isrc',
  TBPM: 'bpm',
  TBP: 'bpm',
};

const LYRICS_FRAMES = ['USLT', 'ULT'];
const PICTURE_FRAMES = ['APIC', 'PIC'];

function decodeText(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const encoding = bytes[0];
  const body = bytes.subarray(1);
  switch (encoding) {
    case 0:
      return latin1(body);
    case 1: {
      if (body.length < 2) return '';
      const little = body[0] === 0xff && body[1] === 0xfe;
      return utf16(body.subarray(2), little);
    }
    case 2:
      return utf16(body, false);
    case 3:
      return utf8(body);
    default:
      return latin1(body);
  }
}

function isWide(encoding: number): boolean {
  return encoding === 1 || encoding === 2;
}

function numeric(value: string): number | undefined {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

/** v2.3 uses plain big-endian sizes; v2.4 uses syncsafe (7 bits per byte). */
function frameSize(bytes: Uint8Array, offset: number, major: number): number {
  if (major === 2) return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
  return major >= 4 ? syncsafe(bytes, offset) : u32be(bytes, offset);
}

function parseApic(body: Uint8Array): string | undefined {
  if (body.length < 4) return undefined;
  const wide = isWide(body[0]);
  const mimeEnd = findNull(body, 1);
  if (mimeEnd < 0) return undefined;
  const mime = latin1(body.subarray(1, mimeEnd)) || 'image/jpeg';
  const descEnd = findNull(body, mimeEnd + 2, wide);
  if (descEnd < 0) return undefined;
  const data = body.subarray(descEnd + (wide ? 2 : 1));
  return data.length === 0 ? undefined : dataUri(data, mime);
}

/** USLT/ULT: encoding, 3-byte language, descriptor, then the lyrics body. */
function parseLyrics(body: Uint8Array): string | undefined {
  if (body.length < 5) return undefined;
  const wide = isWide(body[0]);
  const descEnd = findNull(body, 4, wide);
  if (descEnd < 0) return undefined;
  const text = wide
    ? utf16(body.subarray(descEnd + 2), body[0] === 1 && body[descEnd + 2] === 0xff)
    : body[0] === 3
      ? utf8(body.subarray(descEnd + 1))
      : latin1(body.subarray(descEnd + 1));
  return clean(text) || undefined;
}

/** COMM/COM: encoding, language, descriptor, then the comment text. */
function parseComment(body: Uint8Array): string | undefined {
  if (body.length < 5) return undefined;
  const wide = isWide(body[0]);
  const descEnd = findNull(body, 4, wide);
  if (descEnd < 0) return undefined;
  const text = wide
    ? utf16(body.subarray(descEnd + 2), body[0] === 1 && body[descEnd + 2] === 0xff)
    : body[0] === 3
      ? utf8(body.subarray(descEnd + 1))
      : latin1(body.subarray(descEnd + 1));
  return clean(text) || undefined;
}

function decibels(value: string): number | undefined {
  const match = value.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** TXXX: encoding, description, value. We only care about LYRICS/UNSYNCEDLYRICS. */
function parseUserText(body: Uint8Array): { key: string; value: string } | undefined {
  if (body.length < 2) return undefined;
  const wide = isWide(body[0]);
  const sep = findNull(body, 1, wide);
  if (sep < 0) return undefined;
  const read = (slice: Uint8Array) =>
    body[0] === 1 ? utf16(slice, slice[0] === 0xff && slice[1] === 0xfe) : body[0] === 3 ? utf8(slice) : latin1(slice);
  return { key: clean(read(body.subarray(1, sep))).toUpperCase(), value: clean(read(body.subarray(sep + (wide ? 2 : 1)))) };
}

/**
 * Parse ID3v2 tags from the leading bytes of an audio file.
 * `bytes` only needs to cover the tag; the caller reads a generous window.
 */
export function parseId3(bytes: Uint8Array): Id3Tags {
  const tags: Id3Tags = {};
  if (bytes.length < 10) return tags;
  if (ascii(bytes, 0, 3) !== 'ID3') return tags;

  const major = bytes[3];
  const flags = bytes[5];
  const tagSize = syncsafe(bytes, 6);

  let offset = 10;
  if ((flags & 0x40) !== 0) {
    offset += major >= 4 ? syncsafe(bytes, offset) : u32be(bytes, offset) + 4;
  }

  const end = Math.min(bytes.length, 10 + tagSize);
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;

  while (offset + headerLength <= end) {
    const id = ascii(bytes, offset, idLength);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    const size = frameSize(bytes, offset + idLength, major);
    if (size <= 0 || offset + headerLength + size > end) break;

    const body = bytes.subarray(offset + headerLength, offset + headerLength + size);

    const field = TEXT_FRAMES[id];
    if (field && !tags[field]) {
      const text = clean(decodeText(body));
      if (text) {
        if (field === 'year' || field === 'trackNumber' || field === 'discNumber' || field === 'bpm') {
          const value = numeric(text);
          if (value !== undefined) tags[field] = value as never;
        } else {
          tags[field] = text as never;
        }
      }
    }

    if (!tags.albumArtist && (id === 'TPE2' || id === 'TP2')) {
      tags.albumArtist = clean(decodeText(body)) || undefined;
    }

    if (!tags.lyrics && LYRICS_FRAMES.includes(id)) {
      tags.lyrics = parseLyrics(body);
    }

    if (!tags.comment && (id === 'COMM' || id === 'COM')) {
      tags.comment = parseComment(body);
    }

    if (!tags.lyrics && (id === 'TXXX' || id === 'TXX')) {
      const user = parseUserText(body);
      if (user) {
        if (user.key === 'LYRICS' || user.key === 'UNSYNCEDLYRICS' || user.key === 'UNSYNCED LYRICS') {
          tags.lyrics = user.value || undefined;
        } else if (user.key === 'REPLAYGAIN_TRACK_GAIN' || user.key === 'REPLAY GAIN') {
          tags.gain = decibels(user.value);
        } else if (user.key === 'PUBLISHER' || user.key === 'LABEL') {
          tags.publisher ??= user.value || undefined;
        } else if (user.key === 'COMPOSER') {
          tags.composer ??= user.value || undefined;
        } else if (user.key === 'COMMENT' || user.key === 'DESCRIPTION') {
          tags.comment ??= user.value || undefined;
        }
      }
    }

    if (!tags.artwork && PICTURE_FRAMES.includes(id)) {
      tags.artwork = parseApic(body);
    }

    offset += headerLength + size;
  }

  if ((flags & 0x80) !== 0) {
    for (const key of ['title', 'artist', 'album', 'genre'] as const) {
      const value = tags[key];
      if (value) tags[key] = value.replace(/\xff/g, '').trim();
    }
  }

  return tags;
}

export const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop',
  'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
  'Sound Clip', 'Gospel', 'Noise', 'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative',
  'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial',
  'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave',
  'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz',
  'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

/**
 * ID3v1 lives in the last 128 bytes. Plenty of downloaded MP3s only carry it,
 * so it is worth the twenty lines.
 */
export function parseId3v1(tail: Uint8Array): Id3Tags {
  const tags: Id3Tags = {};
  if (tail.length < 128) return tags;
  const start = tail.length - 128;
  if (ascii(tail, start, 3) !== 'TAG') return tags;

  const field = (offset: number, length: number) =>
    clean(latin1(tail.subarray(start + offset, start + offset + length)));

  const title = field(3, 30);
  const artist = field(33, 30);
  const album = field(63, 30);
  const year = field(93, 4);
  const comment = field(97, 30);

  if (title) tags.title = title;
  if (artist) tags.artist = artist;
  if (album) tags.album = album;
  const parsedYear = numeric(year);
  if (parsedYear) tags.year = parsedYear;

  // v1.1 stores the track number in the last two bytes of the comment field.
  if (comment.length >= 28 && tail[start + 125] === 0 && tail[start + 126] !== 0) {
    tags.trackNumber = tail[start + 126];
  }

  const genre = tail[start + 127];
  if (genre < ID3V1_GENRES.length) tags.genre = ID3V1_GENRES[genre];

  return tags;
}

/** Last resort when there is no tag: pull "Artist - Title" out of the filename. */
export function parseFilename(filename: string): { title?: string; artist?: string } {
  const stem = filename.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/^\d{1,3}[\s._-]+/, '').trim();
  const dash = stem.match(/^(.+?)\s+[-â€“]\s+(.+)$/);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };
  return { title: stem || undefined };
}
