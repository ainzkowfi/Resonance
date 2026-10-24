/**
 * Container sniffing and tag extraction for every format a downloaded music
 * library realistically contains.
 *
 * ExoPlayer (Android) plays mp3, flac, m4a/aac/alac, ogg/opus, wav and aiff;
 * AVPlayer (iOS) plays everything except ogg/opus. `.ape` and `.wv` are read
 * for their tags but cannot be played.
 *
 * Everything here is a pure function over byte windows so it can be tested by
 * `npm run check` without React Native.
 */

import { ascii, clean, dataUri, fromBase64, latin1, u16be, u32be, u32le, utf8 } from './bytes.ts';
import { ID3V1_GENRES, parseId3, parseId3v1, type Id3Tags } from './id3.ts';

export type AudioFormat = 'mp3' | 'flac' | 'mp4' | 'ogg' | 'wav' | 'aiff' | 'ape' | 'wv' | 'unknown';

export type TrackTags = Id3Tags;

export const AUDIO_EXTENSIONS = [
  'mp3', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aiff', 'aif', 'aifc', 'ape', 'wv',
] as const;

export function isAudioFilename(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return !!ext && (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

export function sniffFormat(head: Uint8Array): AudioFormat {
  if (ascii(head, 0, 3) === 'ID3') return 'mp3';
  if (ascii(head, 0, 4) === 'fLaC') return 'flac';
  if (ascii(head, 4, 4) === 'ftyp') return 'mp4';
  if (ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav';
  if (
    ascii(head, 0, 4) === 'FORM' &&
    (ascii(head, 8, 4) === 'AIFF' || ascii(head, 8, 4) === 'AIFC' || ascii(head, 8, 4) === 'AIFF')
  ) {
    return 'aiff';
  }
  if (ascii(head, 0, 4) === 'MAC ') return 'ape';
  if (ascii(head, 0, 4) === 'wvpk') return 'wv';
  // A bare MPEG frame sync means an MP3 with no ID3v2 header.
  if (head.length > 1 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  return 'unknown';
}

function merge(base: TrackTags, extra: TrackTags): TrackTags {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== '' && out[key] === undefined) out[key] = value;
  }
  return out as TrackTags;
}

function numeric(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

/* ------------------------------------------------------------------ Vorbis */

function applyVorbisField(tags: TrackTags, key: string, value: string): void {
  switch (key) {
    case 'TITLE':
    case 'TITLETAG':
      tags.title ??= value;
      break;
    case 'ARTIST':
      tags.artist = tags.artist ? `${tags.artist}; ${value}` : value;
      break;
    case 'ALBUM':
      tags.album ??= value;
      break;
    case 'ALBUMARTIST':
    case 'ALBUM ARTIST':
    case 'ALBUM_ARTIST':
      tags.albumArtist ??= value;
      break;
    case 'GENRE':
      tags.genre ??= value;
      break;
    case 'DATE':
    case 'YEAR':
      tags.year ??= numeric(value);
      break;
    case 'TRACKNUMBER':
      tags.trackNumber ??= numeric(value);
      break;
    case 'DISCNUMBER':
      tags.discNumber ??= numeric(value);
      break;
    case 'ISRC':
      tags.isrc ??= value;
      break;
    case 'BPM':
      tags.bpm ??= numeric(value);
      break;
    case 'LYRICS':
    case 'UNSYNCEDLYRICS':
    case 'UNSYNCED LYRICS':
    case 'SYNCEDLYRICS':
      if (value.trim()) tags.lyrics ??= value;
      break;
    case 'METADATA_BLOCK_PICTURE': {
      if (tags.artwork) break;
      const picture = parseFlacPicture(fromBase64(value));
      if (picture) tags.artwork = dataUri(picture.data, picture.mime);
      break;
    }
    default:
      break;
  }
}

/** Vorbis comment block as used by FLAC, Vorbis and Opus. */
export function parseVorbisComments(bytes: Uint8Array, offset = 0): TrackTags {
  const tags: TrackTags = {};
  if (offset + 8 > bytes.length) return tags;
  const vendorLength = u32le(bytes, offset);
  let cursor = offset + 4 + vendorLength;
  if (cursor + 4 > bytes.length) return tags;
  const count = u32le(bytes, cursor);
  cursor += 4;

  for (let i = 0; i < count && cursor + 4 <= bytes.length; i++) {
    const length = u32le(bytes, cursor);
    cursor += 4;
    if (length <= 0 || cursor + length > bytes.length) break;
    const entry = utf8(bytes.subarray(cursor, cursor + length));
    cursor += length;
    const separator = entry.indexOf('=');
    if (separator > 0) applyVorbisField(tags, entry.slice(0, separator).toUpperCase(), entry.slice(separator + 1));
  }
  return tags;
}

/* -------------------------------------------------------------------- FLAC */

export function parseFlacPicture(bytes: Uint8Array): { mime: string; data: Uint8Array } | undefined {
  let cursor = 0;
  u32be(bytes, cursor);
  cursor += 4;
  const mimeLength = u32be(bytes, cursor);
  cursor += 4;
  if (cursor + mimeLength > bytes.length) return undefined;
  const declared = latin1(bytes.subarray(cursor, cursor + mimeLength)).trim();
  cursor += mimeLength;
  const descriptionLength = u32be(bytes, cursor);
  cursor += 4 + descriptionLength + 16;
  if (cursor + 4 > bytes.length) return undefined;
  const dataLength = u32be(bytes, cursor);
  cursor += 4;
  const data = bytes.subarray(cursor, Math.min(bytes.length, cursor + dataLength));
  if (data.length === 0) return undefined;
  const mime = declared && declared !== '-->' ? declared : '';
  return { mime, data };
}

export function parseFlac(bytes: Uint8Array): TrackTags {
  let tags: TrackTags = {};
  let cursor = 4;
  while (cursor + 4 <= bytes.length) {
    const header = bytes[cursor];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3];
    const body = bytes.subarray(cursor + 4, Math.min(bytes.length, cursor + 4 + length));

    if (type === 4) {
      tags = merge(tags, parseVorbisComments(body, 0));
    } else if (type === 6 && !tags.artwork) {
      const picture = parseFlacPicture(body);
      if (picture) tags.artwork = dataUri(picture.data, picture.mime);
    }

    cursor += 4 + length;
    if (isLast || length <= 0) break;
  }
  return tags;
}

/* --------------------------------------------------------------------- Ogg */

/** Reassemble logical packets from the page/lacing structures. */
export function oggPackets(bytes: Uint8Array, limit = 4): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const chunks: Uint8Array[] = [];
  let cursor = 0;

  while (cursor + 27 <= bytes.length && packets.length < limit) {
    if (ascii(bytes, cursor, 4) !== 'OggS') break;
    const segmentCount = bytes[cursor + 26];
    const tableStart = cursor + 27;
    if (tableStart + segmentCount > bytes.length) break;

    let dataCursor = tableStart + segmentCount;
    for (let i = 0; i < segmentCount; i++) {
      const length = bytes[tableStart + i];
      chunks.push(bytes.subarray(dataCursor, Math.min(bytes.length, dataCursor + length)));
      dataCursor += length;
      if (length < 255) {
        packets.push(concatChunks(chunks));
        chunks.length = 0;
        if (packets.length >= limit) break;
      }
    }
    cursor = dataCursor;
  }

  if (chunks.length > 0 && packets.length < limit) packets.push(concatChunks(chunks));
  return packets;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function parseOgg(bytes: Uint8Array): TrackTags {
  for (const packet of oggPackets(bytes)) {
    if (ascii(packet, 0, 7) === '\x03vorbis') return parseVorbisComments(packet, 7);
    if (ascii(packet, 0, 8) === 'OpusTags') return parseVorbisComments(packet, 8);
    if (ascii(packet, 0, 5) === '\x7fFLAC') {
      const inner = packet.subarray(9);
      if (inner.length > 4) return parseFlac(inner);
    }
  }
  return {};
}

/* --------------------------------------------------------------------- MP4 */

interface Atom {
  type: string;
  body: number;
  end: number;
}

function atoms(bytes: Uint8Array, start: number, end: number): Atom[] {
  const out: Atom[] = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = u32be(bytes, cursor);
    const type = ascii(bytes, cursor + 4, 4);
    let header = 8;
    if (size === 1) {
      size = u32be(bytes, cursor + 8) * 4294967296 + u32be(bytes, cursor + 12);
      header = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (size < header || cursor + size > end + 8) break;
    const stop = Math.min(end, cursor + size);
    out.push({ type, body: cursor + header, end: stop });
    if (stop <= cursor) break;
    cursor = stop;
  }
  return out;
}

function findAtom(bytes: Uint8Array, list: Atom[], type: string): Atom | undefined {
  return list.find((atom) => atom.type === type);
}

function mp4DataPayload(bytes: Uint8Array, item: Atom): { type: number; data: Uint8Array } | undefined {
  const children = atoms(bytes, item.body, item.end);
  const data = findAtom(bytes, children, 'data');
  if (!data) return undefined;
  const declared = u32be(bytes, data.body) & 0x00ffffff;
  return { type: declared, data: bytes.subarray(data.body + 8, data.end) };
}

function mp4Text(bytes: Uint8Array, item: Atom): string | undefined {
  const payload = mp4DataPayload(bytes, item);
  if (!payload) return undefined;
  return clean(payload.type === 2 ? utf8(payload.data) : utf8(payload.data)) || undefined;
}

export function parseMp4(bytes: Uint8Array): TrackTags {
  const tags: TrackTags = {};
  for (const top of atoms(bytes, 0, bytes.length)) {
    if (top.type !== 'moov') continue;
    const moov = atoms(bytes, top.body, top.end);
    const udta = findAtom(bytes, moov, 'udta');
    if (!udta) continue;
    const meta = findAtom(bytes, atoms(bytes, udta.body, udta.end), 'meta');
    if (!meta) continue;
    // `meta` carries a 4-byte version/flags prefix before its children.
    const ilst = findAtom(bytes, atoms(bytes, meta.body + 4, meta.end), 'ilst');
    if (!ilst) continue;

    for (const item of atoms(bytes, ilst.body, ilst.end)) {
      switch (item.type) {
        case '\u00a9nam':
          tags.title ??= mp4Text(bytes, item);
          break;
        case '\u00a9ART':
          tags.artist ??= mp4Text(bytes, item);
          break;
        case 'aART':
          tags.albumArtist ??= mp4Text(bytes, item);
          break;
        case '\u00a9alb':
          tags.album ??= mp4Text(bytes, item);
          break;
        case '\u00a9gen':
          tags.genre ??= mp4Text(bytes, item);
          break;
        case 'gnre': {
          const payload = mp4DataPayload(bytes, item);
          if (payload && payload.data.length >= 2) {
            const index = u16be(payload.data, payload.data.length - 2) - 1;
            if (index >= 0 && index < ID3V1_GENRES.length) tags.genre ??= ID3V1_GENRES[index];
          }
          break;
        }
        case '\u00a9day':
          tags.year ??= numeric(mp4Text(bytes, item));
          break;
        case '\u00a9lyr':
          tags.lyrics ??= mp4Text(bytes, item);
          break;
        case 'tmpo': {
          const payload = mp4DataPayload(bytes, item);
          if (payload && payload.data.length >= 2) tags.bpm ??= u16be(payload.data, 0);
          break;
        }
        case 'trkn': {
          const payload = mp4DataPayload(bytes, item);
          if (payload && payload.data.length >= 4) tags.trackNumber ??= u16be(payload.data, 2);
          break;
        }
        case 'disk': {
          const payload = mp4DataPayload(bytes, item);
          if (payload && payload.data.length >= 4) tags.discNumber ??= u16be(payload.data, 2);
          break;
        }
        case 'covr': {
          const payload = mp4DataPayload(bytes, item);
          if (payload && payload.data.length > 0 && !tags.artwork) {
            const mime = payload.type === 14 ? 'image/png' : payload.type === 13 ? 'image/jpeg' : '';
            tags.artwork = dataUri(payload.data, mime || undefined);
          }
          break;
        }
        case '----': {
          // Free-form atoms: mean/name/data. We only want the ISRC.
          const children = atoms(bytes, item.body, item.end);
          const name = findAtom(bytes, children, 'name');
          if (!name) break;
          const label = latin1(bytes.subarray(name.body + 4, name.end));
          if (label.toUpperCase().includes('ISRC')) {
            const payload = mp4DataPayload(bytes, findAtom(bytes, children, 'data') ?? item);
            if (payload) tags.isrc ??= utf8(payload.data).trim();
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return tags;
}

/* ---------------------------------------------------------------- WAV/AIFF */

function applyInfoField(tags: TrackTags, id: string, value: string): void {
  if (!value) return;
  switch (id) {
    case 'INAM':
      tags.title ??= value;
      break;
    case 'IART':
      tags.artist ??= value;
      break;
    case 'IPRD':
      tags.album ??= value;
      break;
    case 'IGNR':
      tags.genre ??= value;
      break;
    case 'ICRD':
      tags.year ??= numeric(value);
      break;
    case 'ITRK':
      tags.trackNumber ??= numeric(value);
      break;
    case 'ICMT':
      tags.lyrics ??= value;
      break;
    default:
      break;
  }
}

export function parseWav(bytes: Uint8Array): TrackTags {
  let tags: TrackTags = {};
  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = ascii(bytes, cursor, 4);
    const size = u32le(bytes, cursor + 4);
    const body = cursor + 8;
    const end = Math.min(bytes.length, body + size);
    if (size < 0) break;

    if (id === 'LIST' && ascii(bytes, body, 4) === 'INFO') {
      let inner = body + 4;
      while (inner + 8 <= end) {
        const field = ascii(bytes, inner, 4);
        const length = u32le(bytes, inner + 4);
        applyInfoField(tags, field, clean(latin1(bytes.subarray(inner + 8, Math.min(end, inner + 8 + length)))));
        inner += 8 + length + (length & 1);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      tags = merge(tags, parseId3(bytes.subarray(body, end)));
    }

    cursor = body + size + (size & 1);
    if (size === 0) break;
  }
  return tags;
}

export function parseAiff(bytes: Uint8Array): TrackTags {
  let tags: TrackTags = {};
  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const id = ascii(bytes, cursor, 4);
    const size = u32be(bytes, cursor + 4);
    const body = cursor + 8;
    const end = Math.min(bytes.length, body + size);

    if (id === 'NAME') tags.title ??= clean(latin1(bytes.subarray(body, end)));
    else if (id === 'AUTH') tags.artist ??= clean(latin1(bytes.subarray(body, end)));
    else if (id === 'ANNO') tags.lyrics ??= clean(latin1(bytes.subarray(body, end)));
    else if (id === 'ID3 ') tags = merge(tags, parseId3(bytes.subarray(body, end)));

    cursor = body + size + (size & 1);
    if (size === 0) break;
  }
  return tags;
}

/* -------------------------------------------------------------------- APEv2 */

export function parseApev2(bytes: Uint8Array): TrackTags {
  const footer = rfindApeFooter(bytes);
  if (footer < 0) return {};

  const tagSize = u32le(bytes, footer + 12);
  const itemCount = u32le(bytes, footer + 16);
  let cursor = Math.max(0, footer - (tagSize - 32));
  const tags: TrackTags = {};

  for (let i = 0; i < itemCount && cursor + 8 <= footer; i++) {
    const valueSize = u32le(bytes, cursor);
    cursor += 8;
    const keyEnd = bytes.indexOf(0, cursor);
    if (keyEnd < 0) break;
    const key = latin1(bytes.subarray(cursor, keyEnd));
    cursor = keyEnd + 1;
    const value = bytes.subarray(cursor, Math.min(bytes.length, cursor + valueSize));
    cursor += valueSize;

    switch (key.toLowerCase()) {
      case 'title':
        tags.title ??= clean(utf8(value));
        break;
      case 'artist':
        tags.artist ??= clean(utf8(value));
        break;
      case 'album':
        tags.album ??= clean(utf8(value));
        break;
      case 'album artist':
        tags.albumArtist ??= clean(utf8(value));
        break;
      case 'genre':
        tags.genre ??= clean(utf8(value));
        break;
      case 'year':
        tags.year ??= numeric(utf8(value));
        break;
      case 'track':
        tags.trackNumber ??= numeric(utf8(value));
        break;
      case 'disc':
        tags.discNumber ??= numeric(utf8(value));
        break;
      case 'isrc':
        tags.isrc ??= clean(utf8(value));
        break;
      case 'bpm':
        tags.bpm ??= numeric(utf8(value));
        break;
      case 'lyrics':
      case 'unsyncedlyrics':
        tags.lyrics ??= clean(utf8(value));
        break;
      case 'cover art (front)':
      case 'cover art (back)': {
        if (tags.artwork) break;
        const nul = value.indexOf(0);
        const image = nul >= 0 ? value.subarray(nul + 1) : value;
        if (image.length > 0) tags.artwork = dataUri(image);
        break;
      }
      default:
        break;
    }
  }
  return tags;
}

function rfindApeFooter(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 8192);
  for (let i = bytes.length - 32; i >= start; i--) {
    if (ascii(bytes, i, 8) === 'APETAGEX') return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ facade */

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG_SAMPLE_RATES = [44100, 48000, 32000];

/**
 * Exact duration for the containers that store it, and a Xing/VBRI-or-bitrate
 * estimate for MP3. Falls back to `undefined` so the player can fill it in on
 * first load.
 */
export function parseDuration(
  head: Uint8Array,
  format: AudioFormat,
  fileSize: number,
  tail?: Uint8Array,
): number | undefined {
  try {
    switch (format) {
      case 'flac': {
        // STREAMINFO is the first metadata block.
        if (ascii(head, 0, 4) === 'fLaC' && head.length > 42) {
          const body = 8;
          const sampleRate = (head[body + 10] << 12) | (head[body + 11] << 4) | (head[body + 12] >> 4);
          const totalSamples = (head[body + 13] & 0x0f) * 4294967296 + u32be(head, body + 14);
          if (sampleRate > 0 && totalSamples > 0) return totalSamples / sampleRate;
        }
        return undefined;
      }
      case 'mp4': {
        for (const top of atoms(head, 0, head.length)) {
          if (top.type !== 'moov') continue;
          const mvhd = findAtom(head, atoms(head, top.body, top.end), 'mvhd');
          if (!mvhd) continue;
          const version = head[mvhd.body];
          const timescale = version === 1 ? u32be(head, mvhd.body + 20) : u32be(head, mvhd.body + 12);
          const duration =
            version === 1
              ? u32be(head, mvhd.body + 24) * 4294967296 + u32be(head, mvhd.body + 28)
              : u32be(head, mvhd.body + 16);
          if (timescale > 0 && duration > 0) return duration / timescale;
        }
        return undefined;
      }
      case 'wav': {
        let byteRate = 0;
        let dataSize = 0;
        let cursor = 12;
        while (cursor + 8 <= head.length) {
          const id = ascii(head, cursor, 4);
          const size = u32le(head, cursor + 4);
          if (id === 'fmt ') byteRate = u32le(head, cursor + 16);
          if (id === 'data') {
            dataSize = size;
            break;
          }
          cursor += 8 + size + (size & 1);
          if (size === 0) break;
        }
        return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : undefined;
      }
      case 'aiff': {
        let cursor = 12;
        while (cursor + 8 <= head.length) {
          const id = ascii(head, cursor, 4);
          const size = u32be(head, cursor + 4);
          if (id === 'COMM') {
            const frames = u32be(head, cursor + 10);
            const rate = extended80(head, cursor + 16);
            return rate > 0 && frames > 0 ? frames / rate : undefined;
          }
          cursor += 8 + size + (size & 1);
          if (size === 0) break;
        }
        return undefined;
      }
      case 'mp3': {
        let offset = 0;
        if (ascii(head, 0, 3) === 'ID3') offset = 10 + syncsafeAt(head, 6);
        if (offset + 4 > head.length) return undefined;
        const b1 = head[offset + 1];
        const b2 = head[offset + 2];
        if (head[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;

        const version = (b1 >> 3) & 0x03;
        const layer = (b1 >> 1) & 0x03;
        if (layer !== 0x01) return estimateFromBitrate(head, offset, fileSize);
        const sampleRate = MPEG_SAMPLE_RATES[(b2 >> 2) & 0x03];
        const samplesPerFrame = version === 3 ? 1152 : 576;
        if (!sampleRate) return undefined;

        const xing = findAscii(head, 'Xing', offset + 4, offset + 200) ?? findAscii(head, 'Info', offset + 4, offset + 200);
        if (xing > 0) {
          const flags = u32be(head, xing + 4);
          if (flags & 1) {
            const frames = u32be(head, xing + 8);
            if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
          }
        }
        const vbri = findAscii(head, 'VBRI', offset + 4, offset + 200);
        if (vbri > 0) {
          const frames = u32be(head, vbri + 14);
          if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
        }
        return estimateFromBitrate(head, offset, fileSize);
      }
      case 'ogg': {
        // Granule position of the last page lives in the tail window.
        if (!tail || tail.length < 27) return undefined;
        let cursor = tail.length - 27;
        while (cursor >= 0) {
          if (ascii(tail, cursor, 4) === 'OggS') {
            const granule = u32le(tail, cursor + 10) * 4294967296 + u32le(tail, cursor + 6);
            // Opus always runs at 48 kHz regardless of the original rate.
            const rate = findAscii(head, 'OpusHead', 0, 64) >= 0 ? 48000 : 44100;
            return granule > 0 ? granule / rate : undefined;
          }
          cursor--;
        }
        return undefined;
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function syncsafeAt(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function findAscii(bytes: Uint8Array, needle: string, from: number, to: number): number {
  const limit = Math.min(bytes.length, to) - needle.length;
  for (let i = Math.max(0, from); i <= limit; i++) {
    if (ascii(bytes, i, needle.length) === needle) return i;
  }
  return -1;
}

function estimateFromBitrate(head: Uint8Array, offset: number, fileSize: number): number | undefined {
  const b1 = head[offset + 1];
  const b2 = head[offset + 2];
  const version = (b1 >> 3) & 0x03;
  const table = version === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES;
  const bitrate = table[(b2 >> 4) & 0x0f];
  if (!bitrate || fileSize <= offset) return undefined;
  return ((fileSize - offset) * 8) / (bitrate * 1000);
}

/** 80-bit IEEE 754 extended float, as used by AIFF's sample rate. */
function extended80(bytes: Uint8Array, offset: number): number {
  const exponent = ((bytes[offset] & 0x7f) << 8) | bytes[offset + 1];
  const mantissa = u32be(bytes, offset + 2) * 4294967296 + u32be(bytes, offset + 6);
  if (exponent === 0 && mantissa === 0) return 0;
  return mantissa * Math.pow(2, exponent - 16383 - 63);
}

/**
 * Read tags from a head window (and, when the format keeps them at the end, a
 * tail window). Returns whatever could be decoded - never throws.
 */

export function parseTags(head: Uint8Array, tail?: Uint8Array): TrackTags {
  const format = sniffFormat(head);
  try {
    switch (format) {
      case 'mp3': {
        let tags = parseId3(head);
        if (tail) tags = merge(tags, parseId3v1(tail));
        return tags;
      }
      case 'flac':
        return parseFlac(head);
      case 'ogg':
        return parseOgg(head);
      case 'mp4':
        return parseMp4(head);
      case 'wav':
        return parseWav(head);
      case 'aiff':
        return parseAiff(head);
      case 'ape':
      case 'wv':
        return tail ? parseApev2(tail) : {};
      default:
        return tail ? parseApev2(tail) : {};
    }
  } catch {
    return {};
  }
}
