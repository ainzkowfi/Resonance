/**
 * What the native player can open.
 *
 * ExoPlayer (Android, this app's only platform) handles mp3, flac, m4a/aac,
 * alac, ogg/opus, wav and aiff; it does not handle Monkey's Audio (`.ape`) or
 * WavPack (`.wv`), yet both are indexed into the library, because tag parsing
 * can read them.
 *
 * That gap used to be invisible: a track that the player refused simply never
 * started. These rules are pure so the decisions — is this file playable —
 * are covered by `scripts/check.mts` instead of only by a device.
 */

export type PlaybackPlatform = 'ios' | 'android' | 'other';

/** Native error or state, shown in the player and worth a diagnostics entry. */
export interface PlaybackNotice {
  tone: 'info' | 'error';
  message: string;
  /** Raw native player text, for the diagnostics log. */
  detail?: string;
}

/** Ogg/Opus: ExoPlayer opens them, AVPlayer does not. */
const IOS_ONLY_GAP = new Set(['ogg', 'oga', 'opus']);

/** Neither platform's player opens these, though the scanner still reads tags. */
const NEITHER_PLATFORM = new Set(['ape', 'wv']);

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
