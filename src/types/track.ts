export type TrackSource = 'local';

export interface Track {
  /** Stable id derived from the local audio file URI. */
  id: string;
  source: TrackSource;
  /** Local audio file URI. */
  uri: string;
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  artwork?: string;
  /** Seconds. */
  duration: number;
  genre?: string;
  composer?: string;
  conductor?: string;
  lyricist?: string;
  publisher?: string;
  copyright?: string;
  comment?: string;
  grouping?: string;
  encoder?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  isrc?: string;
  bpm?: number;
  /** ReplayGain dB. */
  gain?: number;
  /** Sidecar `.lrc`/`.txt` next to the audio file, for downloaded libraries. */
  lyricsUri?: string;
}

export interface Lyrics {
  /** LRC-formatted text with `[mm:ss.xx]` timestamps. */
  synced?: string;
  plain?: string;
  source: 'local';
}

export type RepeatMode = 'off' | 'one' | 'all';
