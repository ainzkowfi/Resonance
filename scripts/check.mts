import assert from 'node:assert/strict';

import { applyLibraryFilter, EMPTY_FILTER } from '../src/lib/filter.ts';
import { fuzzyScore, fuzzySearch } from '../src/lib/fuzzy.ts';
import { parseId3, parseId3v1, parseFilename } from '../src/lib/id3.ts';
import { activeLineIndex, parseLrc, parsePlainLyrics } from '../src/lib/lrc.ts';
import { basename, findCoverSidecar, findLyricsSidecar, looksLikeLrc, stemOf } from '../src/lib/lyrics.ts';
import {
  declaredTagBytes,
  headWindowBytes,
  MAX_TAG_BYTES,
  parseAiff,
  parseApev2,
  parseDuration,
  parseFlac,
  parseMp4,
  parseTags,
  parseWav,
  sniffFormat,
} from '../src/lib/tags.ts';
import { planAnalysisQueue } from '../src/lib/analysisQueue.ts';
import { crossfadeStart, normalizeCrossfade } from '../src/lib/crossfade.ts';
import { median, sampleFromTiming, summarizeHandoffs } from '../src/lib/handoff.ts';
import { PRELOAD_LEAD_SECONDS, shouldPreload } from '../src/lib/preload.ts';
import { buildCapabilities, condenseListing, formatReport, listNames } from '../src/lib/ffmpegReport.ts';
import { evaluateExportCheck, selfTestWav } from '../src/lib/encodeCheck.ts';
import { targetFromSamples, trackGainDb, volumeForGain } from '../src/lib/leveling.ts';
import { leadSkip, tailOut } from '../src/lib/silence.ts';
import { columnsForWidth, resamplePeaks } from '../src/lib/waveform.ts';
import { analyzeWav, peaksFromWav } from '../src/lib/wav.ts';

let checks = 0;
function ok(condition: boolean, message: string) {
  assert.ok(condition, message);
  checks += 1;
}

// ---------------------------------------------------------------- LRC parser

const lrc = ['[ar:Rick Astley]', '[00:12.34]Never gonna give', '[00:15.00]You up', 'untimed line'].join(
  '\n',
);

const lines = parseLrc(lrc);
ok(lines.length === 2, `expected 2 timed lines, got ${lines.length}`);
ok(lines[0].time === 12.34, `expected 12.34, got ${lines[0].time}`);
ok(lines[0].text === 'Never gonna give', `unexpected text "${lines[0].text}"`);
ok(lines[1].time === 15, `expected 15, got ${lines[1].time}`);

const fractions = parseLrc('[00:01.5]a\n[00:02.05]b\n[00:03.005]c');
ok(fractions[0].time === 1.5, 'one decimal fraction');
ok(fractions[1].time === 2.05, 'two decimal fraction');
ok(fractions[2].time === 3.005, 'three decimal fraction');

const multi = parseLrc('[00:10.00][00:20.00]repeated');
ok(multi.length === 2, 'a line can carry several timestamps');
ok(multi[0].time === 10 && multi[1].time === 20, 'both timestamps kept');
ok(multi[0].text === 'repeated' && multi[1].text === 'repeated', 'text kept on both');

const unsorted = parseLrc('[00:30.00]b\n[00:10.00]a');
ok(unsorted[0].time === 10 && unsorted[1].time === 30, 'lines are sorted by time');

ok(parseLrc('no timestamps at all').length === 0, 'untimed input yields no lines');

ok(activeLineIndex(lines, 0) === -1, 'before the first line there is no active line');
ok(activeLineIndex(lines, 12.34) === 0, 'exact timestamp activates its line');
ok(activeLineIndex(lines, 13) === 0, 'mid-line keeps the previous line active');
ok(activeLineIndex(lines, 15) === 1, 'later timestamp activates the next line');
ok(activeLineIndex(lines, 9999) === 1, 'past the end clamps to the last line');
ok(activeLineIndex([], 5) === -1, 'empty list has no active line');

const plain = parsePlainLyrics('\n  first  \n\nsecond\n   \n');
ok(plain.length === 2, 'blank lines are dropped');
ok(plain[0] === 'first' && plain[1] === 'second', 'plain lines are trimmed');

// --------------------------------------------------------------- ID3 parser

function syncsafe(size: number): number[] {
  return [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
}

function u32(size: number): number[] {
  return [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff];
}

function textFrame(id: string, text: string, major: number): number[] {
  const body = [0x00, ...Array.from(text, (char) => char.charCodeAt(0))];
  const size = major >= 4 ? syncsafe(body.length) : u32(body.length);
  return [...Array.from(id, (char) => char.charCodeAt(0)), ...size, 0, 0, ...body];
}

function apicFrame(payload: number[], major: number): number[] {
  const body = [0x00, ...Array.from('image/png', (c) => c.charCodeAt(0)), 0x00, 0x03, 0x00, ...payload];
  const id = major === 2 ? 'PIC' : 'APIC';
  const size = major >= 4 ? syncsafe(body.length) : u32(body.length);
  return [...Array.from(id, (char) => char.charCodeAt(0)), ...size, 0, 0, ...body];
}

function buildTag(major: number, frames: number[][]): Uint8Array {
  const payload = frames.flat();
  const header = [0x49, 0x44, 0x33, major, 0x00, 0x00, ...syncsafe(payload.length)];
  return new Uint8Array([...header, ...payload]);
}

const v23 = parseId3(
  buildTag(3, [
    textFrame('TIT2', 'Never Gonna Give You Up', 3),
    textFrame('TPE1', 'Rick Astley', 3),
    textFrame('TALB', 'Whenever You Need Somebody', 3),
    textFrame('TCON', 'Pop', 3),
    textFrame('TYER', '1987', 3),
    textFrame('TRCK', '3', 3),
    textFrame('TPOS', '1/2', 3),
  ]),
);
ok(v23.title === 'Never Gonna Give You Up', `title was "${v23.title}"`);
ok(v23.artist === 'Rick Astley', `artist was "${v23.artist}"`);
ok(v23.album === 'Whenever You Need Somebody', `album was "${v23.album}"`);
ok(v23.genre === 'Pop', `genre was "${v23.genre}"`);
ok(v23.year === 1987, `year was "${v23.year}"`);
ok(v23.trackNumber === 3, `track was "${v23.trackNumber}"`);
ok(v23.discNumber === 1, `disc was "${v23.discNumber}"`);

const v24 = parseId3(
  buildTag(4, [textFrame('TIT2', 'Syncsafe Title', 4), textFrame('TDRC', '2021-05-01', 4)]),
);
ok(v24.title === 'Syncsafe Title', `v2.4 title was "${v24.title}"`);
ok(v24.year === 2021, `v2.4 year was "${v24.year}"`);

const withArt = parseId3(buildTag(3, [apicFrame([1, 2, 3, 4, 5], 3)]));
ok(withArt.artwork?.startsWith('data:image/png;base64,'), 'artwork becomes a data URI');
ok(withArt.artwork?.endsWith('AQIDBAU='), `artwork payload was "${withArt.artwork}"`);

ok(Object.keys(parseId3(new Uint8Array(4))).length === 0, 'a truncated buffer yields no tags');
ok(
  Object.keys(parseId3(new TextEncoder().encode('not an id3 tag at all'))).length === 0,
  'a non-ID3 buffer yields no tags',
);
ok(Object.keys(parseId3(new Uint8Array(0))).length === 0, 'an empty buffer yields no tags');

const named = parseFilename('07 - Rick Astley - Never Gonna Give You Up.mp3');
ok(named.artist === 'Rick Astley', `filename artist was "${named.artist}"`);
ok(named.title === 'Never Gonna Give You Up', `filename title was "${named.title}"`);
ok(parseFilename('Untitled Recording.m4a').title === 'Untitled Recording', 'filename without a dash');

// ------------------------------------------------------ multi-format reader

function asciiBytes(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}
function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}
function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function be16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}
function le16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}
function padEven(bytes: number[]): number[] {
  return bytes.length % 2 === 0 ? bytes : [...bytes, 0];
}

// FLAC
function flacBlock(type: number, last: boolean, body: number[]): number[] {
  const length = body.length;
  return [(last ? 0x80 : 0) | type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...body];
}
function vorbisComment(fields: [string, string][]): number[] {
  const vendor = utf8Bytes('Resonance');
  const entries = fields.flatMap(([key, value]) => {
    const entry = utf8Bytes(`${key}=${value}`);
    return [...le32(entry.length), ...entry];
  });
  return [...le32(vendor.length), ...vendor, ...le32(fields.length), ...entries];
}

// 44100 Hz, stereo, 16-bit, 200 seconds.
const streamInfo = [
  ...be16(4096),
  ...be16(4096),
  0, 0, 0,
  0, 0, 0,
  10, 196, 66, 240, ...be32(8820000),
  ...new Array<number>(16).fill(0),
];
ok(streamInfo.length === 34, `streaminfo should be 34 bytes, got ${streamInfo.length}`);

const flacBytes = new Uint8Array([
  ...asciiBytes('fLaC'),
  ...flacBlock(0, false, streamInfo),
  ...flacBlock(
    4,
    true,
    vorbisComment([
      ['TITLE', 'Flac Title'],
      ['ARTIST', 'Flac Artist'],
      ['ALBUM', 'Flac Album'],
      ['DATE', '1998'],
      ['TRACKNUMBER', '4'],
      ['GENRE', 'Jazz'],
      ['LYRICS', '[00:01.00]flac line'],
    ]),
  ),
]);

ok(sniffFormat(flacBytes) === 'flac', `flac sniff was "${sniffFormat(flacBytes)}"`);
const flacTags = parseFlac(flacBytes);
ok(flacTags.title === 'Flac Title', `flac title was "${flacTags.title}"`);
ok(flacTags.artist === 'Flac Artist', `flac artist was "${flacTags.artist}"`);
ok(flacTags.album === 'Flac Album', `flac album was "${flacTags.album}"`);
ok(flacTags.year === 1998, `flac year was "${flacTags.year}"`);
ok(flacTags.trackNumber === 4, `flac track was "${flacTags.trackNumber}"`);
ok(flacTags.genre === 'Jazz', `flac genre was "${flacTags.genre}"`);
ok(flacTags.lyrics === '[00:01.00]flac line', `flac lyrics was "${flacTags.lyrics}"`);
ok(parseDuration(flacBytes, 'flac', flacBytes.length) === 200, 'flac duration is 200s');

// MP4 / M4A
function atom(type: string, payload: number[]): number[] {
  return [...be32(8 + payload.length), ...asciiBytes(type), ...payload];
}
function dataAtom(typeIndicator: number, payload: number[]): number[] {
  return atom('data', [0, 0, 0, typeIndicator, 0, 0, 0, 0, ...payload]);
}

const ilst = atom('ilst', [
  ...atom('\u00a9nam', dataAtom(1, utf8Bytes('Mp4 Title'))),
  ...atom('\u00a9ART', dataAtom(1, utf8Bytes('Mp4 Artist'))),
  ...atom('\u00a9alb', dataAtom(1, utf8Bytes('Mp4 Album'))),
  ...atom('\u00a9day', dataAtom(1, utf8Bytes('2003-04-05'))),
  ...atom('trkn', dataAtom(0, [0, 0, 0, 7, 0, 1, 0, 0])),
  ...atom('covr', dataAtom(13, [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
]);
const mp4Bytes = new Uint8Array([
  ...atom('ftyp', asciiBytes('M4A ')),
  ...atom('moov', atom('udta', atom('meta', [0, 0, 0, 0, ...ilst]))),
]);

ok(sniffFormat(mp4Bytes) === 'mp4', `mp4 sniff was "${sniffFormat(mp4Bytes)}"`);
const mp4Tags = parseMp4(mp4Bytes);
ok(mp4Tags.title === 'Mp4 Title', `mp4 title was "${mp4Tags.title}"`);
ok(mp4Tags.artist === 'Mp4 Artist', `mp4 artist was "${mp4Tags.artist}"`);
ok(mp4Tags.album === 'Mp4 Album', `mp4 album was "${mp4Tags.album}"`);
ok(mp4Tags.year === 2003, `mp4 year was "${mp4Tags.year}"`);
ok(mp4Tags.trackNumber === 7, `mp4 track was "${mp4Tags.trackNumber}"`);
ok(mp4Tags.artwork?.startsWith('data:image/jpeg;base64,'), 'mp4 cover is a jpeg data URI');

// WAV
const wavFmt = [...le16(1), ...le16(2), ...le32(44100), ...le32(176400), ...le16(4), ...le16(16)];
const infoChunks = [
  ...asciiBytes('INAM'),
  ...le32(9),
  ...padEven(utf8Bytes('Wav Title')),
  ...asciiBytes('IART'),
  ...le32(10),
  ...padEven(utf8Bytes('Wav Artist')),
];
const wavBytes = new Uint8Array([
  ...asciiBytes('RIFF'),
  ...le32(0),
  ...asciiBytes('WAVE'),
  ...asciiBytes('fmt '),
  ...le32(wavFmt.length),
  ...wavFmt,
  ...asciiBytes('LIST'),
  ...le32(4 + infoChunks.length),
  ...asciiBytes('INFO'),
  ...infoChunks,
  ...asciiBytes('data'),
  ...le32(1764000),
]);

ok(sniffFormat(wavBytes) === 'wav', `wav sniff was "${sniffFormat(wavBytes)}"`);
const wavTags = parseWav(wavBytes);
ok(wavTags.title === 'Wav Title', `wav title was "${wavTags.title}"`);
ok(wavTags.artist === 'Wav Artist', `wav artist was "${wavTags.artist}"`);
ok(parseDuration(wavBytes, 'wav', wavBytes.length) === 10, 'wav duration is 10s');

// AIFF
function aiffChunk(id: string, text: string): number[] {
  const body = utf8Bytes(text);
  return [...asciiBytes(id), ...be32(body.length), ...padEven(body)];
}
const aiffBytes = new Uint8Array([
  ...asciiBytes('FORM'),
  ...be32(0),
  ...asciiBytes('AIFF'),
  ...aiffChunk('NAME', 'Aiff Title'),
  ...aiffChunk('AUTH', 'Aiff Artist'),
]);
ok(sniffFormat(aiffBytes) === 'aiff', `aiff sniff was "${sniffFormat(aiffBytes)}"`);
const aiffTags = parseAiff(aiffBytes);
ok(aiffTags.title === 'Aiff Title', `aiff title was "${aiffTags.title}"`);
ok(aiffTags.artist === 'Aiff Artist', `aiff artist was "${aiffTags.artist}"`);

// AIFF duration: COMM = channels(2) frames(4) sampleSize(2) rate(10)
// 44100 Hz as an 80-bit extended float is 40 0E AC 44 00 00 00 00 00 00.
function commChunk(frames: number): number[] {
  const body = [
    ...be16(2),
    ...be32(frames),
    ...be16(16),
    0x40, 0x0e, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  return [...asciiBytes('COMM'), ...be32(body.length), ...body];
}
const aiffTimed = new Uint8Array([
  ...asciiBytes('FORM'),
  ...be32(0),
  ...asciiBytes('AIFF'),
  ...aiffChunk('NAME', 'Aiff Title'),
  ...commChunk(44100 * 3),
]);
ok(
  parseDuration(aiffTimed, 'aiff', aiffTimed.length) === 3,
  `aiff duration was ${parseDuration(aiffTimed, 'aiff', aiffTimed.length)}`,
);

// Ogg: granule of the last page / codec rate (Opus is fixed at 48 kHz).
function oggHead(codecId: number[], pageCount: number): Uint8Array {
  const packet = [...codecId, ...new Uint8Array(16)];
  return new Uint8Array([
    ...asciiBytes('OggS'), 0, 2,
    ...le32(0), ...le32(0),
    ...le32(1), ...le32(0), ...le32(pageCount),
    1, packet.length,
    ...packet,
  ]);
}
function oggTail(granule: number): Uint8Array {
  return new Uint8Array([
    ...asciiBytes('OggS'), 0, 4,
    ...le32(granule), ...le32(Math.floor(granule / 4294967296)),
    ...le32(1), ...le32(1), ...le32(0),
    0,
  ]);
}
const opusHead = oggHead(asciiBytes('OpusHead'), 1);
const opusTail = oggTail(48000 * 6);
ok(
  parseDuration(opusHead, 'ogg', 1000, opusTail) === 6,
  `opus duration was ${parseDuration(opusHead, 'ogg', 1000, opusTail)}`,
);
const vorbisHead = oggHead([0x01, ...asciiBytes('vorbis')], 1);
const vorbisTail = oggTail(44100 * 4);
ok(
  parseDuration(vorbisHead, 'ogg', 1000, vorbisTail) === 4,
  `vorbis duration was ${parseDuration(vorbisHead, 'ogg', 1000, vorbisTail)}`,
);

// APEv2 (tail)
function apeItem(key: string, value: string): number[] {
  const body = utf8Bytes(value);
  return [...le32(body.length), ...le32(0), ...asciiBytes(key), 0x00, ...body];
}
const apeItems = [...apeItem('Title', 'Ape Title'), ...apeItem('Artist', 'Ape Artist')];
const apeFooter = [
  ...asciiBytes('APETAGEX'),
  ...le32(2000),
  ...le32(apeItems.length + 32),
  ...le32(2),
  ...le32(0),
  ...new Array<number>(8).fill(0),
];
const apeBytes = new Uint8Array([...apeItems, ...apeFooter]);
const apeTags = parseApev2(apeBytes);
ok(apeTags.title === 'Ape Title', `ape title was "${apeTags.title}"`);
ok(apeTags.artist === 'Ape Artist', `ape artist was "${apeTags.artist}"`);

// ID3v1 (tail of an MP3 with no ID3v2)
const id3v1Tail = new Uint8Array(128);
id3v1Tail.set(utf8Bytes('TAG'), 0);
id3v1Tail.set(utf8Bytes('V1 Title'), 3);
id3v1Tail.set(utf8Bytes('V1 Artist'), 33);
id3v1Tail.set(utf8Bytes('V1 Album'), 63);
id3v1Tail.set(utf8Bytes('1999'), 93);
id3v1Tail.set(utf8Bytes('a comment'), 97);
id3v1Tail[126] = 5;
id3v1Tail[127] = 13;
const v1Tags = parseId3v1(id3v1Tail);
ok(v1Tags.title === 'V1 Title', `id3v1 title was "${v1Tags.title}"`);
ok(v1Tags.artist === 'V1 Artist', `id3v1 artist was "${v1Tags.artist}"`);
ok(v1Tags.year === 1999, `id3v1 year was "${v1Tags.year}"`);
ok(v1Tags.trackNumber === 5, `id3v1 track was "${v1Tags.trackNumber}"`);
ok(v1Tags.genre === 'Pop', `id3v1 genre was "${v1Tags.genre}"`);
ok(Object.keys(parseId3v1(new Uint8Array(10))).length === 0, 'short tail yields no id3v1 tags');

// Facade must never throw on garbage.
const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
ok(Object.keys(parseTags(garbage)).length === 0, 'parseTags tolerates garbage');
ok(sniffFormat(garbage) === 'unknown', `garbage sniff was "${sniffFormat(garbage)}"`);
const tagged = parseTags(flacBytes);
ok(tagged.title === 'Flac Title', 'parseTags routes FLAC');

// ------------------------------------------------------- sidecar discovery

const safUri =
  'content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2FAlbums%2FSong.mp3';
ok(basename(safUri) === 'Song.mp3', `basename was "${basename(safUri)}"`);
ok(basename('file:///storage/emulated/0/Music/a%20song.flac') === 'a song.flac', 'basename decodes');
ok(stemOf('01 - Song.mp3') === '01 - Song', `stemOf was "${stemOf('01 - Song.mp3')}"`);

const folderFiles = ['Song.mp3', 'Song.lrc', 'song.LRC', 'cover.jpg', 'Other.txt'];
ok(
  findLyricsSidecar(folderFiles, 'Song.mp3') === 'Song.lrc',
  `sidecar was "${findLyricsSidecar(folderFiles, 'Song.mp3')}"`,
);
ok(findCoverSidecar(['art.jpg', 'folder.png']) === 'folder.png', 'folder.jpg wins over art.jpg');
ok(findCoverSidecar(['notes.txt']) === undefined, 'no cover when nothing matches');
ok(looksLikeLrc('[00:12.34]hello'), 'timed text is detected');
ok(!looksLikeLrc('just words'), 'plain text is not LRC');

// ------------------------------------------------------------ library filter

const sample = (uri: string, duration: number) => ({
  id: `local:${uri}`,
  source: 'local' as const,
  uri,
  title: 'Signal Test',
  artist: 'QA',
  duration,
});
const scanned = [sample('a.mp3', 30), sample('b.mp3', 200), sample('c.mp3', 10)];

ok(applyLibraryFilter(scanned, EMPTY_FILTER).length === 3, 'filter keeps every track by default');
ok(
  applyLibraryFilter(scanned, { ...EMPTY_FILTER, minDuration: 120 })
    .map((track) => track.uri)
    .join() === 'b.mp3',
  'short tracks are filtered out',
);
ok(
  applyLibraryFilter(scanned, { ...EMPTY_FILTER, hidden: ['a.mp3'] }).length === 2,
  'hidden tracks are removed',
);
ok(
  applyLibraryFilter(scanned, { ...EMPTY_FILTER, overrides: { 'a.mp3': { title: 'Renamed' } } })[0]
    .title === 'Renamed',
  'overrides replace scanned tags',
);

// --------------------------------------------------------------- fuzzy search

ok(fuzzyScore('sig', 'Signal Test') !== undefined, 'fuzzy matches a prefix');
ok(fuzzyScore('signl', 'Signal Test') !== undefined, 'fuzzy skips characters');
ok(fuzzyScore('bjork', 'Björk') !== undefined, 'fuzzy ignores diacritics');
ok(fuzzyScore('qqq', 'Signal Test') === undefined, 'fuzzy rejects non-subsequences');
ok(fuzzyScore('', 'Signal Test') === undefined, 'empty query never matches');
ok(
  (fuzzyScore('sig', 'Signal Test') ?? 0) > (fuzzyScore('sig', 'Something Interesting Going') ?? 0),
  'closer matches outrank scattered ones',
);
ok(
  fuzzySearch('sig', ['Something Interesting Going', 'Signal Test'], (item) => item)[0] ===
    'Signal Test',
  'fuzzySearch sorts best first',
);

// ------------------------------------------------------------ waveform peaks

/** Builds a mono 16-bit WAV, optionally with a junk chunk before `data`. */
function makeWav(samples: Int16Array, sampleRate = 8000, junkBytes?: number): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const dataView = new DataView(data.buffer);
  for (let i = 0; i < samples.length; i++) dataView.setInt16(i * 2, samples[i], true);

  const junk = junkBytes ?? 0;
  const header = new Uint8Array(44 + (junk > 0 ? 8 + junk + (junk % 2) : 0));
  const view = new DataView(header.buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  };

  const bodyBytes = 36 + data.length + (junk > 0 ? 8 + junk + (junk % 2) : 0);
  writeText(0, 'RIFF');
  view.setUint32(4, bodyBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  let cursor = 36;
  if (junk > 0) {
    writeText(cursor, 'JUNK');
    view.setUint32(cursor + 4, junk, true);
    cursor += 8 + junk + (junk % 2);
  }
  writeText(cursor, 'data');
  view.setUint32(cursor + 4, data.length, true);
  cursor += 8;

  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
}

// One second of silence, then one second of a full-scale tone.
const half = 8000;
const tone = new Int16Array(half * 2);
for (let i = half; i < half * 2; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 8000) > 0 ? 30000 : -30000;

const peaks = peaksFromWav(makeWav(tone), 96);
ok(peaks !== undefined, 'peaks are produced from a valid WAV');
ok(peaks?.length === 96, `expected 96 bars, got ${peaks?.length}`);
ok(peaks?.every((value) => value >= 0 && value <= 1), 'peaks stay inside 0..1');
ok((peaks?.[0] ?? 1) < 0.01, 'the silent half is drawn flat');
ok((peaks?.[95] ?? 0) > 0.9, 'the loud half reaches the top of the waveform');
ok(Math.max(...(peaks ?? [0])) === 1, 'the loudest bar normalises to 1');

const withJunk = peaksFromWav(makeWav(tone, 8000, 7), 96);
ok(withJunk?.length === 96, 'unknown chunks before data are skipped');
ok(withJunk?.[95] === peaks?.[95], 'a junk chunk does not change the peaks');

ok(peaksFromWav(makeWav(new Int16Array(half)), 96) === undefined, 'silence yields no waveform');
ok(peaksFromWav(new Uint8Array(44), 96) === undefined, 'an empty WAV yields no waveform');
ok(peaksFromWav(makeWav(tone), 0) === undefined, 'a zero bar count is rejected');

// ------------------------------------------------------- declared tag window

/** A bare ID3v2 header carrying `tagSize` as a syncsafe integer. */
function id3Header(tagSize: number, major = 3, flags = 0): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes[0] = 0x49; // I
  bytes[1] = 0x44; // D
  bytes[2] = 0x33; // 3
  bytes[3] = major;
  bytes[5] = flags;
  bytes[6] = (tagSize >> 21) & 0x7f;
  bytes[7] = (tagSize >> 14) & 0x7f;
  bytes[8] = (tagSize >> 7) & 0x7f;
  bytes[9] = tagSize & 0x7f;
  return bytes;
}

ok(declaredTagBytes(id3Header(1000)) === 1010, 'an ID3v2.3 header declares header plus body');
ok(declaredTagBytes(id3Header(0x2a)) === 52, 'the declared size is syncsafe, not a plain integer');
ok(
  declaredTagBytes(id3Header(1000, 4, 0x10)) === 1020,
  'a v2.4 footer is counted towards the tag',
);
ok(
  declaredTagBytes(id3Header(1000, 3, 0x10)) === 1010,
  'v2.3 has no footer, so the flag does not extend the window',
);
ok(declaredTagBytes(id3Header(0)) === undefined, 'an empty tag declares nothing to read');
ok(
  declaredTagBytes(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34, 0, 0])) === undefined,
  'containers without a declared tag length report undefined',
);
ok(declaredTagBytes(new Uint8Array(4)) === undefined, 'a truncated header is not trusted');

/** An ID3v2.3 tag holding a large cover first and the title after it. */
function tagWithLateTitle(pictureBytes: number): Uint8Array {
  const frame = (id: string, body: Uint8Array) => {
    const header = new Uint8Array(10);
    for (let i = 0; i < 4; i++) header[i] = id.charCodeAt(i);
    const size = body.length;
    header[4] = (size >> 24) & 0xff;
    header[5] = (size >> 16) & 0xff;
    header[6] = (size >> 8) & 0xff;
    header[7] = size & 0xff;
    const out = new Uint8Array(10 + body.length);
    out.set(header);
    out.set(body, 10);
    return out;
  };

  const mime = 'image/jpeg';
  // encoding, mime, zero, picture type, empty description, then image bytes.
  const apic = new Uint8Array(mime.length + 4 + pictureBytes);
  apic[mime.length + 1] = 0;
  apic[mime.length + 2] = 3;
  apic[mime.length + 3] = 0;
  for (let i = 0; i < mime.length; i++) apic[1 + i] = mime.charCodeAt(i);

  const title = 'Late Title';
  const tit2 = new Uint8Array(1 + title.length);
  tit2[0] = 3; // UTF-8
  for (let i = 0; i < title.length; i++) tit2[1 + i] = title.charCodeAt(i);

  const body = [...frame('APIC', apic), ...frame('TIT2', tit2)];
  const header = id3Header(body.length);
  const out = new Uint8Array(10 + body.length);
  out.set(header);
  out.set(body, 10);
  return out;
}

const lateTag = tagWithLateTitle(70_000);
ok(declaredTagBytes(lateTag) === lateTag.length, 'the declared size covers the whole tag');
ok(parseTags(lateTag).title === 'Late Title', 'reading the declared size recovers a late title');
ok(parseTags(lateTag).artwork !== undefined, 'and the cover that precedes it');
ok(
  parseTags(lateTag.subarray(0, 64 * 1024)).title === undefined,
  'a 64 KB window would have cut the tag off before the title',
);

ok(
  headWindowBytes(64 * 1024, 4 * 1024, 5_000_000) === 64 * 1024,
  'a small declared tag needs no second read',
);
ok(
  headWindowBytes(64 * 1024, 200 * 1024, 5_000_000) === 200 * 1024,
  'a declared tag larger than the first window is read exactly',
);
ok(
  headWindowBytes(64 * 1024, 5 * 1024 * 1024, 9_000_000) === MAX_TAG_BYTES,
  'a huge declared tag is capped at the old fixed read',
);
ok(
  headWindowBytes(64 * 1024, 4 * 1024, 1000) === 1000,
  'a window never reads past the end of the file',
);
ok(
  headWindowBytes(64 * 1024, undefined, 5_000_000) === 64 * 1024,
  'an undeclared tag leaves the first window alone',
);

// ------------------------------------------------------ ffmpeg capability probe

const filterListing = [
  'Filters:',
  ' T.. = Timeline support',
  ' TSC aformat         A->A       Convert the input audio to one of the specified formats.',
  ' ..C atrim           A->A       Pick one continuous section from the input.',
  ' T.. volume          A->A       Change input volume.',
  ' ... loudnorm        A->A       EBU R128 loudness normalization.',
  ' ... showwavespic    A->V       Draw a waveform.',
  ' ... vflip           V->V       Flip the input video vertically.',
].join('\n');

const encoderListing = [
  'Encoders:',
  ' V..... = Video',
  ' A.... = Audio',
  ' A..... aac            AAC (Advanced Audio Coding)',
  ' A..... libmp3lame     libmp3lame MP3 (MPEG audio layer 3)',
].join('\n');

const muxerListing = [
  'File formats:',
  '  E  mp4             MP4 (MPEG-4 Part 14)',
  '  E  ipod            iPod H.264 MP4',
  '  E  wav             WAV / WAVE (Waveform Audio)',
].join('\n');

const decoderListing = [
  'Decoders:',
  ' A.... pcm_s16le        PCM signed 16-bit little-endian',
  ' A.... flac             FLAC (Free Lossless Audio Codec)',
].join('\n');

const names = listNames(filterListing);
ok(names.has('atrim') && names.has('volume'), 'filter names are parsed out of the listing');
ok(names.has('aformat'), 'names with unusual flags columns are still parsed');
ok(!names.has('filters:'), 'header lines are ignored');
ok(listNames(muxerListing).has('mp4'), 'two-character flag columns are parsed');
ok(listNames(decoderListing).has('pcm_s16le'), 'decoder names are parsed');

const full = buildCapabilities({
  filters: filterListing,
  encoders: encoderListing,
  muxers: muxerListing,
  decoders: decoderListing,
});
const byLabel = (label: string) => full.find((item) => item.label === label);
ok(byLabel('Waveform decode (PCM → WAV)')?.ok === true, 'waveform decode is detected');
ok(byLabel('AAC encoder')?.ok === true, 'aac encoder is detected');
ok(byLabel('MP4 / M4A muxer')?.ok === true, 'mp4 muxer is detected');
ok(byLabel('Trim filter')?.ok === true, 'trim filter is detected');
ok(byLabel('MP3 encoder (libmp3lame)')?.ok === true, 'libmp3lame is reported when present');
ok(full.length === 9, `expected 9 capabilities, got ${full.length}`);

const empty = buildCapabilities({ filters: '', encoders: '', muxers: '', decoders: '' });
ok(empty.every((item) => !item.ok), 'an empty listing reports nothing as supported');
ok(
  buildCapabilities({
    filters: filterListing,
    encoders: encoderListing,
    muxers: muxerListing,
    decoders: '',
  }).find((item) => item.label === 'Waveform decode (PCM → WAV)')?.ok === false,
  'a missing decoder marks waveform decode as unsupported',
);

const condensed = condenseListing(filterListing);
ok(condensed.every((line) => !line.includes('vflip')), 'unrelated filters are dropped from the report');
ok(condensed.some((line) => line.includes('volume')), 'relevant filters are kept');
ok(condenseListing(filterListing, 2).length === 2, 'the condensed listing honours the line cap');

const report = formatReport({
  version: '6.1.1',
  device: 'android 34',
  capabilities: full,
  listings: {
    filters: filterListing,
    encoders: encoderListing,
    muxers: muxerListing,
    decoders: decoderListing,
  },
});
ok(report.includes('6.1.1'), 'the report carries the version');
ok(report.includes('[yes] AAC encoder'), 'supported capabilities are marked');
ok(!report.includes('vflip'), 'the shared report stays filtered');

// ---------------------------------------------------------- export self-test

const wav = selfTestWav();
ok(wav.length === 44 + 16_000, `a second of 8 kHz mono is 16044 bytes, got ${wav.length}`);
ok(sniffFormat(wav) === 'wav', 'the self-test input is recognised as a WAV');
ok(wav.some((byte) => byte !== 0), 'the test signal is not silence');
ok(parseDuration(wav, 'wav', wav.length) === 1, 'the test signal declares one second of audio');

const passed = evaluateExportCheck({ returnCode: 0, bytes: 16_384, ms: 320 });
ok(passed.ok, 'a successful encode passes');
ok(passed.message.includes('16.0 KB'), 'a pass reports how much was written');
ok(passed.message.includes('320 ms'), 'a pass reports how long it took');

const crashed = evaluateExportCheck({ returnCode: 1, bytes: 0, ms: 20 });
ok(!crashed.ok, 'a non-zero exit fails the test');
ok(crashed.message.includes('code 1'), 'the failure names the exit code');
ok(!evaluateExportCheck({ returnCode: 0, bytes: 0, ms: 10 }).ok, 'success with no file still fails');
ok(!evaluateExportCheck({ returnCode: 0, bytes: 400, ms: 10 }).ok, 'an implausibly small file fails');

const withSelfTest = formatReport({
  version: '6.1.1',
  device: 'android 34',
  capabilities: full,
  selfTest: passed,
  listings: { filters: '', encoders: '', muxers: '', decoders: '' },
});
ok(withSelfTest.includes('export round trip: passed'), 'the report states the round trip result');
ok(!report.includes('export round trip'), 'a report without a run leaves the line out');

// --------------------------------------------------- loudness and silence

const analysis = analyzeWav(makeWav(tone), { barCount: 96, sampleRate: 8000 });
ok(analysis !== undefined, 'a tone produces an analysis');
ok(analysis?.peaks.length === 96, 'the analysis carries the peaks');
ok((analysis?.rmsDb ?? 0) > -2 && (analysis?.rmsDb ?? 0) < -0.2, 'a full-scale tone measures near 0 dBFS');
ok((analysis?.peakDb ?? -99) < 0, 'sample peak stays below full scale');
ok(Math.abs((analysis?.lead ?? 0) - 1) < 0.05, `leading silence is about 1 s, got ${analysis?.lead}`);
ok((analysis?.tail ?? 1) < 0.05, 'no trailing silence is reported');
ok(
  JSON.stringify(analysis?.peaks) === JSON.stringify(peaksFromWav(makeWav(tone), 96)),
  'peaksFromWav and analyzeWav agree',
);

const toneFirst = new Int16Array(half * 2);
for (let i = 0; i < half; i++) toneFirst[i] = Math.sin((2 * Math.PI * 440 * i) / 8000) > 0 ? 30000 : -30000;
const tailAnalysis = analyzeWav(makeWav(toneFirst), { barCount: 96, sampleRate: 8000 });
ok((tailAnalysis?.lead ?? 1) < 0.05, 'no leading silence is reported when audio starts immediately');
ok(Math.abs((tailAnalysis?.tail ?? 0) - 1) < 0.05, `trailing silence is about 1 s, got ${tailAnalysis?.tail}`);

ok(analyzeWav(new Uint8Array(44)) === undefined, 'an empty WAV yields no analysis');
ok(analyzeWav(makeWav(tone), { barCount: 0 }) === undefined, 'a zero bar count is rejected');

// ------------------------------------------------------------- leveling maths

ok(targetFromSamples([]) === -16, 'the fallback target is used with no samples');
ok(targetFromSamples([-10, -12, -14]) === -16, 'too few samples fall back to the default');
ok(targetFromSamples([-10, -12, -14, -16, -18, -20]) === -15, 'an even sample count uses the middle pair');
ok(targetFromSamples([-9, -11, -13, -15, -17]) === -13, 'an odd sample count uses the middle value');
ok(targetFromSamples([-10, 5, Number.NaN, -20, -30, -40, -50]) === -30, 'invalid samples are ignored');

ok(trackGainDb({ rmsDb: -10, targetDb: -16 }) === -6, 'a loud track is attenuated to the target');
ok(trackGainDb({ rmsDb: -22, targetDb: -16 }) === 0, 'a quiet track is never boosted');
ok(trackGainDb({ rmsDb: 0, targetDb: -20 }) === -18, 'attenuation is capped');
ok(trackGainDb({ tagGainDb: -3.5, targetDb: -16 }) === -3.5, 'a ReplayGain tag is used when unanalysed');
ok(trackGainDb({ tagGainDb: 4, targetDb: -16 }) === 0, 'a positive tag gain is discarded');
ok(trackGainDb({ targetDb: -16 }) === 0, 'an unknown track is left at unity');
ok(
  trackGainDb({ rmsDb: Number.NaN, tagGainDb: -2, targetDb: -16 }) === -2,
  'a non-finite measurement falls back to the tag',
);

ok(volumeForGain(0) === 1, 'unity gain is full volume');
ok(Math.abs(volumeForGain(-6) - 0.5012) < 0.001, 'a 6 dB cut halves the volume');
ok(volumeForGain(-18) < 0.13, 'an 18 dB cut is quiet but audible');
ok(volumeForGain(6) === 1, 'volume never exceeds full scale');
ok(volumeForGain(Number.NaN) === 1, 'a broken gain leaves the volume alone');

// ------------------------------------------------------------ silence skipping

ok(leadSkip(4, 0) === 4, 'a long lead is skipped from the start');
ok(leadSkip(4, 10) === 0, 'a resume past the lead is never undone');
ok(leadSkip(4, 4) === 0, 'a position already at the lead does not skip again');
ok(leadSkip(0.4, 0) === 0, 'short silence is part of the music');
ok(leadSkip(undefined, 0) === 0, 'an unanalysed track is left alone');
ok(leadSkip(Number.NaN, 0) === 0, 'a broken lead is ignored');
ok(leadSkip(4, Number.NaN) === 0, 'an unknown position is left alone');
ok(leadSkip(3, 0) === 3, 'the threshold is inclusive of 2 s and above');

ok(tailOut(200, 5) === 195, 'a long outro is cut short');
ok(tailOut(200, 1) === 0, 'a short outro plays out');
ok(tailOut(5, 5) === 0, 'a track barely longer than its outro is left alone');
ok(tailOut(Number.NaN, 5) === 0, 'an unknown duration never cuts the track');
ok(tailOut(200, undefined) === 0, 'an unanalysed tail never cuts the track');
ok(tailOut(200, 2) === 198, 'exactly 2 s of outro is skippable');

// ------------------------------------------------------- waveform resampling

ok(columnsForWidth(0) === 0, 'a zero width has no columns');
ok(columnsForWidth(Number.NaN) === 0, 'an unknown width has no columns');
ok(columnsForWidth(300) === 100, 'columns scale with width');
ok(columnsForWidth(20000) === 240, 'columns are capped for very wide screens');
ok(columnsForWidth(10) === 24, 'narrow layouts keep a minimum bar count');

const stored = [0.1, 0.9, 0.2, 0.3, 0.8, 0.4, 0.5, 0.6];
ok(resamplePeaks(stored, 4).length === 4, 'resampling produces the requested count');
ok(resamplePeaks(stored, 4)[0] === 0.9, 'the loudest peak in each bucket survives');
ok(resamplePeaks(stored, 8).join() === stored.join(), 'equal counts pass through unchanged');
ok(resamplePeaks(stored, 16).length === 16, 'upsampling repeats values');
ok(resamplePeaks([], 10).length === 0, 'no peaks means no bars');
ok(resamplePeaks(stored, 0).length === 0, 'zero columns means no bars');
ok(
  resamplePeaks(stored, 3).every((value) => value >= 0 && value <= 1),
  'resampled peaks stay normalised',
);
ok(
  resamplePeaks([0.5, Number.NaN, 0.25], 3).every((value) => Number.isFinite(value)),
  'a broken stored peak does not leak into the drawing',
);

// ----------------------------------------------------------- analysis queue

const library = [
  { id: 'a', uri: 'file:///a.mp3' },
  { id: 'b', uri: '' },
  { id: 'c', uri: 'file:///c.mp3' },
  { id: 'd', uri: 'file:///d.mp3' },
];
const noneCached = () => false;
const allCached = () => true;
const cCached = (id: string) => id === 'c';

ok(
  planAnalysisQueue(library, noneCached).map((track) => track.id).join() === 'a,c,d',
  'the queue skips tracks without a source and keeps library order',
);
ok(planAnalysisQueue(library, cCached).map((track) => track.id).join() === 'a,d', 'cached tracks are skipped');
ok(planAnalysisQueue(library, allCached).length === 0, 'nothing to do when everything is cached');
ok(planAnalysisQueue(library, noneCached, 2).length === 2, 'the queue respects the per-run cap');
ok(planAnalysisQueue(library, noneCached, 0).length === 0, 'a zero cap plans nothing');
ok(planAnalysisQueue([], noneCached).length === 0, 'an empty library plans nothing');
ok(planAnalysisQueue(library, noneCached, 100).length === 3, 'a generous cap still stops at real work');

// ---------------------------------------------------------------- crossfade

ok(normalizeCrossfade(4) === 4, 'a whole-second blend is kept');
ok(normalizeCrossfade(2.4) === 2, 'a fractional blend rounds down');
ok(normalizeCrossfade(2.6) === 3, 'a fractional blend rounds up');
ok(normalizeCrossfade(-3) === 0, 'a negative blend is off');
ok(normalizeCrossfade(Number.NaN) === 0, 'a broken blend is off');
ok(normalizeCrossfade(120) === 12, 'a greedy blend is capped');
ok(normalizeCrossfade(0) === 0, 'zero means off');

ok(crossfadeStart(200, 4) === 196, 'the next track starts before the boundary');
ok(crossfadeStart(200, 0) === 0, 'no blend means no early start');
ok(crossfadeStart(200, Number.NaN) === 0, 'a broken blend means no early start');
ok(crossfadeStart(Number.NaN, 4) === 0, 'an unknown duration never triggers an advance');
ok(crossfadeStart(8, 4) === 0, 'a track barely twice the blend is left alone');
ok(crossfadeStart(9, 4) === 5, 'a track just long enough still blends');
ok(crossfadeStart(4, 12) === 0, 'a blend longer than the track is ignored');

// ------------------------------------------------------------- handoff timing

const measured = sampleFromTiming({
  requestedAt: 1000,
  playRequestedAt: 1010,
  firstAudibleAt: 1260,
  currentTime: 0.22,
  crossfade: false,
  preloaded: false,
});
ok(measured?.queueDelayMs === 10, 'queue delay is the time to reach play()');
ok(measured?.startLatencyMs === 30, 'the reported position is subtracted from the latency');
ok(measured?.totalMs === 40, 'total handoff is queue delay plus start latency');

ok(
  sampleFromTiming({
    requestedAt: 1000,
    playRequestedAt: 0,
    firstAudibleAt: 1260,
    currentTime: 0.22,
    crossfade: false,
  })?.queueDelayMs === 0,
  'a missing play timestamp falls back to the request time',
);
ok(
  sampleFromTiming({
    requestedAt: 1000,
    playRequestedAt: 1010,
    firstAudibleAt: 9000,
    currentTime: 0.5,
    crossfade: false,
  }) === undefined,
  'a stalled transition is discarded',
);
ok(
  sampleFromTiming({
    requestedAt: 1000,
    playRequestedAt: 1010,
    firstAudibleAt: 1100,
    currentTime: 5,
    crossfade: false,
  })?.startLatencyMs === 0,
  'a position ahead of the clock never produces negative latency',
);
ok(
  sampleFromTiming({
    requestedAt: 1000,
    playRequestedAt: 1010,
    firstAudibleAt: 1010,
    currentTime: 0,
    crossfade: false,
  }) === undefined,
  'a transition with no elapsed time is discarded',
);

ok(median([5, 1, 3]) === 3, 'median of an odd count');
ok(median([40, 10, 30, 20]) === 25, 'median of an even count averages the middle pair');
ok(median([]) === 0, 'median of nothing is zero');

const hardCut = { at: 1, queueDelayMs: 40, startLatencyMs: 120, totalMs: 160, crossfade: false };
const blend = { at: 2, queueDelayMs: 30, startLatencyMs: 10, totalMs: 40, crossfade: true };
ok(summarizeHandoffs([]) === null, 'no samples means no summary');
ok(summarizeHandoffs([blend]) === null, 'crossfades are excluded from the hard-cut summary');
ok(summarizeHandoffs([hardCut, blend])?.medianMs === 160, 'hard cuts are summarised');
ok(summarizeHandoffs([hardCut, blend])?.count === 1, 'only hard cuts are counted');
ok(
  summarizeHandoffs([
    hardCut,
    { ...hardCut, totalMs: 240 },
    { ...hardCut, totalMs: 400 },
  ])?.worstMs === 400,
  'the worst case is reported',
);

// -------------------------------------------------------------- preloading

ok(PRELOAD_LEAD_SECONDS === 15, 'the preload window is 15 s');
ok(shouldPreload({ duration: 200, currentTime: 186, prepared: false }), 'inside the window preloads');
ok(!shouldPreload({ duration: 200, currentTime: 180, prepared: false }), 'outside the window waits');
ok(!shouldPreload({ duration: 200, currentTime: 186, prepared: true }), 'a prepared track is not prepared twice');
ok(!shouldPreload({ duration: 0, currentTime: 0, prepared: false }), 'an unknown duration never preloads');
ok(!shouldPreload({ duration: 200, currentTime: 200, prepared: false }), 'a finished track does not preload');
ok(!shouldPreload({ duration: 200, currentTime: 260, prepared: false }), 'a position past the end does not preload');
ok(!shouldPreload({ duration: Number.NaN, currentTime: 10, prepared: false }), 'a broken duration never preloads');
ok(!shouldPreload({ duration: 200, currentTime: Number.NaN, prepared: false }), 'a broken position never preloads');
ok(shouldPreload({ duration: 6, currentTime: 0, prepared: false }), 'a short track preloads immediately');

// Preloaded and cold transitions are reported separately; the sample maths is
// identical apart from the flag.
const preloadedSample = sampleFromTiming({
  requestedAt: 1000,
  playRequestedAt: 1001,
  firstAudibleAt: 1060,
  currentTime: 0.05,
  crossfade: false,
  preloaded: true,
});
ok(preloadedSample?.preloaded === true, 'the sample records that the player was preloaded');
ok(preloadedSample?.totalMs === 10, 'a preloaded handoff is measured the same way');
const coldSample = { ...preloadedSample!, preloaded: false };
ok(
  summarizeHandoffs([preloadedSample!, coldSample])?.preloaded?.count === 1,
  'preloaded transitions are grouped',
);
ok(summarizeHandoffs([preloadedSample!, coldSample])?.cold?.count === 1, 'cold transitions are grouped');
ok(
  summarizeHandoffs([
    preloadedSample!,
    { ...coldSample, totalMs: coldSample.totalMs + 400 },
  ])?.cold?.medianMs === coldSample.totalMs + 400,
  'each group carries its own median',
);

console.log(`ok - ${checks} checks passed`);
