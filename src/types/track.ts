export type TrackSource = 'local' | 'catalog';

export interface Track {
  /** Provider-scoped unique id: `local:<assetId>` or `catalog:<itunesTrackId>`. */
  id: string;
  source: TrackSource;
  /** Playable URI: `file://` for local assets, `https://` for catalog previews. */
  uri: string;
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  /** Seconds. */
  duration: number;
  genre?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  isrc?: string;
  bpm?: number;
  /** ReplayGain dB. */
  gain?: number;
  /** True when the URI is a 30s catalog preview rather than a full track. */
  isPreview?: boolean;
  /** Sidecar `.lrc`/`.txt` next to the audio file, for downloaded libraries. */
  lyricsUri?: string;
}

export interface Lyrics {
  /** LRC-formatted text with `[mm:ss.xx]` timestamps. */
  synced?: string;
  plain?: string;
  source: 'lrclib' | 'lyrics.ovh' | 'local';
}

export interface TrackInfo {
  track: Track;
  lyrics?: Lyrics;
  /** Tracks by similar artists. */
  similar: Track[];
  artistBio?: string;
  artistGenres: string[];
  albumYear?: number;
  releaseDate?: string;
  label?: string;
  /** MusicBrainz artist id, used to deep-link the artist screen. */
  artistMbid?: string;
  /** MusicBrainz release id, used to fetch cover art from the Cover Art Archive. */
  releaseMbid?: string;
  /** Which providers answered, for the "sources" strip in the UI. */
  providers: string[];
}

export type RepeatMode = 'off' | 'one' | 'all';
