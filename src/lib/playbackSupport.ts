/**
 * What the native player can open, and what to do when it cannot.
 *
 * `tags.ts` records the split: ExoPlayer (Android) handles mp3, flac, m4a/aac,
 * alac, ogg/opus, wav and aiff; AVPlayer (iOS) handles all of those except
 * ogg/opus. Neither handles Monkey's Audio (`.ape`) or WavPack (`.wv`), yet all
 * of them are indexed into the library, because tag parsing can read them.
 *
 * That gap used to be invisible: a track that the player refused simply never
 * started. These rules are pure so the decisions — is this file playable here,
 * is a converted copy worth the encode, what arguments produce it — are covered
 * by `scripts/check.mts` instead of only by a device.
 */

export type PlaybackPlatform = 'ios' | 'android' | 'other';

/** Native error or state, shown in the player and worth a diagnostics entry. */
export interface PlaybackNotice {
  tone: 'info' | 'error';
  message: string;
  /** Raw native/FFmpeg text, for the diagnostics log. */
  detail?: string;
}

/** Ogg/Opus: ExoPlayer opens them, AVPlayer does not. */
const IOS_ONLY_GAP = new Set(['ogg', 'oga', 'opus']);

/** Neither platform's player opens these, though the scanner still reads tags. */
const NEITHER_PLATFORM = new Set(['ape', 'wv']);

/** Containers the packaged FFmpeg build is documented to decode. */
const FFMPEG_DECODES = new Set([
  'aac',
  'aif',
  'aifc',
  'aiff',
  'ape',
  'flac',
  'm4a',
  'm4b',
  'mp3',
  'mp4',
  'oga',
  'ogg',
  'opus',
  'wav',
  'wv',
]);

/** 128 kbps keeps a five-minute copy around 5 MB. */
export const TRANSCODE_BITRATE_KBPS = 128;

/** Extension of a track URI, lowercased, ignoring a query or fragment. */
export function extensionOf(uri: string): string | undefined {
  const match = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(uri);
  return match ? match[1].toLowerCase() : undefined;
}

/** Maps React Native's `Platform.OS` onto the three cases that matter here. */
export function playbackPlatform(os: string): PlaybackPlatform {
  if (os === 'ios') return 'ios';
  if (os === 'android') return 'android';
  return 'other';
}

/**
 * `undefined` when the native player should be given the file, otherwise the
 * sentence explaining why it will not open it.
 *
 * Unknown extensions and missing ones return `undefined`: the player may still
 * handle a container the scanner did not recognise, and a guess is worse than
 * letting it try.
 */
export function unsupportedReason(uri: string, platform: PlaybackPlatform): string | undefined {
  const extension = extensionOf(uri);
  if (!extension) return undefined;
  if (NEITHER_PLATFORM.has(extension)) {
    return `${extension.toUpperCase()} files cannot be played by the system player on either platform.`;
  }
  if (platform === 'ios' && IOS_ONLY_GAP.has(extension)) {
    return `iOS cannot play ${extension.toUpperCase()} files.`;
  }
  return undefined;
}

/** Whether the native player is expected to open this file at all. */
export function nativeCanPlay(uri: string, platform: PlaybackPlatform): boolean {
  return unsupportedReason(uri, platform) === undefined;
}

/**
 * Whether converting the file is worth attempting.
 *
 * Only for a container the platform cannot open *and* FFmpeg can decode. A
 * failed load of an otherwise supported format is far more likely to be a
 * damaged file, and re-encoding it would cost seconds to fail again.
 */
export function shouldTranscode(uri: string, platform: PlaybackPlatform): boolean {
  if (nativeCanPlay(uri, platform)) return false;
  const extension = extensionOf(uri);
  return extension !== undefined && FFMPEG_DECODES.has(extension);
}

/**
 * The command a converted copy is produced with.
 *
 * The same shape a clip export would use — decode the source, encode AAC, mux
 * MP4 — so a copy that plays here also proves that path. `-vn` drops embedded
 * artwork, which has no place in an audio file and only slows the encode.
 */
export function transcodeArgs(input: {
  source: string;
  output: string;
  bitrateKbps?: number;
}): string[] {
  return [
    '-y',
    '-i',
    input.source,
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    `${input.bitrateKbps ?? TRANSCODE_BITRATE_KBPS}k`,
    '-f',
    'mp4',
    '-movflags',
    '+faststart',
    input.output,
  ];
}
