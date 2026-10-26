import AsyncStorage from '@react-native-async-storage/async-storage';
import { File } from 'expo-file-system';
import { create } from 'zustand';

import { applyLibraryFilter, EMPTY_FILTER, type TrackOverrides } from '../lib/filter';
import { addExclusion, removeExclusion } from '../lib/folderExclusions';
import {
  groupAlbums,
  groupArtists,
  pickMusicFolder,
  requestAudioPermission,
  scanLocalLibrary,
  syncFolder,
  type PermissionState,
} from '../library/local';
import type { Track } from '../types/track';

type LibraryView = 'tracks' | 'albums' | 'artists' | 'playlists';

const FOLDER_KEY = 'resonance:music-folder';
const PREFS_KEY = 'resonance:library-prefs';
const LIBRARY_CACHE_KEY = 'resonance:library-cache';
const OFFLINE_MIGRATION_KEY = 'resonance:offline-migration-v1';

async function clearLegacyOnlineMetadata(): Promise<void> {
  try {
    if (await AsyncStorage.getItem(OFFLINE_MIGRATION_KEY)) return;
    const keys = await AsyncStorage.getAllKeys();
    const metadataKeys = keys.filter((key) => key.startsWith('resonance:meta:'));
    if (metadataKeys.length > 0) await AsyncStorage.multiRemove(metadataKeys);
    await AsyncStorage.setItem(OFFLINE_MIGRATION_KEY, 'done');
  } catch {
    // A failed cleanup must not block access to the local music library.
  }
}

export interface Playlist {
  id: string;
  name: string;
  /** Library URIs, in playlist order. Missing files are skipped on read. */
  uris: string[];
}

interface LibraryPrefs {
  hidden: string[];
  overrides: Record<string, TrackOverrides>;
  minDuration: number;
  playlists: Playlist[];
  /** Folders left out of folder scans, including everything beneath them. */
  excludedFolders: string[];
}

/**
 * The folder the user granted is remembered so the library survives a restart.
 * The URI comes back from the system picker, so it is re-read rather than
 * re-derivable.
 */
export async function loadMusicFolder(): Promise<string | undefined> {
  try {
    return (await AsyncStorage.getItem(FOLDER_KEY)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function loadPrefs(): Promise<LibraryPrefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    const empty = { ...EMPTY_FILTER, playlists: [], excludedFolders: [] };
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<LibraryPrefs>) } : empty;
  } catch {
    return { ...EMPTY_FILTER, playlists: [], excludedFolders: [] };
  }
}

async function loadLibraryCache(scope: string): Promise<Track[] | undefined> {
  try {
    const raw = await AsyncStorage.getItem(LIBRARY_CACHE_KEY);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as { scope?: string; tracks?: Track[] };
    return cached.scope === scope && Array.isArray(cached.tracks) ? cached.tracks : undefined;
  } catch {
    return undefined;
  }
}

async function saveLibraryCache(scope: string, tracks: Track[]): Promise<void> {
  try {
    await AsyncStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({ scope, tracks }));
  } catch {
    // A cache failure only means the next launch has to scan again.
  }
}

interface LibraryState extends LibraryPrefs {
  permission: PermissionState | 'unknown';
  /** Everything on disk, before the filters below. */
  entries: Track[];
  tracks: Track[];
  albums: ReturnType<typeof groupAlbums>;
  artists: ReturnType<typeof groupArtists>;
  scanning: boolean;
  cacheLoaded: boolean;
  progress: { done: number; total: number } | null;
  error?: string;
  view: LibraryView;
  folder?: string;

  hydrate: () => Promise<void>;
  request: () => Promise<void>;
  pickFolder: () => Promise<void>;
  /** Opens the folder picker and stops scanning that folder. */
  pickExcludedFolder: () => Promise<void>;
  /** Scans the excluded folder again after its exclusion is removed. */
  includeFolderAgain: (uri: string) => Promise<void>;
  scan: () => Promise<void>;
  /** Re-reads the folder and applies only the files that appeared or left. */
  sync: () => Promise<void>;
  setView: (view: LibraryView) => void;
  /** Drops a track from the list; the file stays on disk. */
  hideTrack: (track: Track) => Promise<void>;
  /** Brings a single hidden track back into the list. */
  unhideTrack: (track: Track) => Promise<void>;
  /** Brings every removed track back into the list. */
  restoreHidden: () => Promise<void>;
  /** Deletes the audio file, then drops it from the list. */
  deleteFile: (track: Track) => Promise<void>;
  setMetadata: (track: Track, patch: TrackOverrides) => Promise<void>;
  setMinDuration: (seconds: number) => Promise<void>;
  createPlaylist: (name: string) => string;
  addToPlaylist: (id: string, track: Track) => Promise<void>;
  removeFromPlaylist: (id: string, track: Track) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
}

/** One watcher tick at a time; a slow folder must not stack scans. */
let syncing = false;

let prefs: Promise<LibraryPrefs> | null = null;
function ensurePrefs(): Promise<LibraryPrefs> {
  prefs ??= loadPrefs();
  return prefs;
}

function savePrefs(state: LibraryState): void {
  const value: LibraryPrefs = {
    hidden: state.hidden,
    overrides: state.overrides,
    minDuration: state.minDuration,
    playlists: state.playlists,
    excludedFolders: state.excludedFolders,
  };
  prefs = Promise.resolve(value);
  void AsyncStorage.setItem(PREFS_KEY, JSON.stringify(value)).catch(() => {});
}

function derive(entries: Track[], filter: LibraryPrefs) {
  const tracks = applyLibraryFilter(entries, filter);
  return { entries, tracks, albums: groupAlbums(tracks), artists: groupArtists(tracks) };
}

/** Playlist URIs resolved against the scanned library, in playlist order. */
export function resolvePlaylist(
  playlist: Playlist,
  entries: Track[],
  overrides: Record<string, TrackOverrides>,
): Track[] {
  const byUri = new Map(entries.map((entry) => [entry.uri, entry]));
  const found = playlist.uris.flatMap((uri) => {
    const track = byUri.get(uri);
    return track ? [track] : [];
  });
  return applyLibraryFilter(found, { hidden: [], minDuration: 0, overrides });
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  ...EMPTY_FILTER,
  playlists: [],
  excludedFolders: [],
  permission: 'unknown',
  entries: [],
  tracks: [],
  albums: [],
  artists: [],
  scanning: false,
  cacheLoaded: false,
  progress: null,
  view: 'tracks',

  hydrate: async () => {
    await clearLegacyOnlineMetadata();
    const loaded = await ensurePrefs();
    set(loaded);
    const folder = await loadMusicFolder();
    const scope = folder ?? 'media-store';
    set({ folder });
    const cached = await loadLibraryCache(scope);
    if (cached !== undefined) {
      set({
        ...derive(cached, loaded),
        permission: folder ? 'granted' : 'unknown',
        cacheLoaded: true,
      });
      return;
    }
    if (!folder) return;
    await get().scan();
  },

  request: async () => {
    const permission = await requestAudioPermission();
    set({ permission });
    if (permission === 'granted' && !get().folder && !get().cacheLoaded) await get().scan();
  },

  pickFolder: async () => {
    const folder = await pickMusicFolder();
    if (!folder) return;
    set({ folder, cacheLoaded: false });
    try {
      await AsyncStorage.setItem(FOLDER_KEY, folder);
    } catch {
      // A folder we cannot remember still works for this session.
    }
    await get().scan();
  },

  pickExcludedFolder: async () => {
    const folder = await pickMusicFolder();
    if (!folder) return;
    const excludedFolders = addExclusion(get().excludedFolders, folder);
    if (excludedFolders.length === get().excludedFolders.length) return;
    set({ excludedFolders });
    savePrefs(get());
    // Rescanning is what removes the tracks already listed from that folder.
    await get().scan();
  },

  includeFolderAgain: async (uri) => {
    set({ excludedFolders: removeExclusion(get().excludedFolders, uri) });
    savePrefs(get());
    await get().scan();
  },

  scan: async () => {
    if (get().scanning) return;
    const folder = get().folder;
    const excluded = get().excludedFolders;
    const loaded = await ensurePrefs();
    set({ scanning: true, error: undefined, progress: { done: 0, total: 0 }, ...loaded });
    try {
      let lastProgressAt = 0;
      const entries = await scanLocalLibrary({
        folder,
        excluded,
        onProgress: (done, total) => {
          const now = Date.now();
          if (done === total || done === 1 || now - lastProgressAt >= 1000) {
            lastProgressAt = now;
            set({ progress: { done, total } });
          }
        },
      });
      if (get().folder !== folder) {
        set({ scanning: false, progress: null });
        await get().scan();
        return;
      }
      const scope = folder ?? 'media-store';
      await saveLibraryCache(scope, entries);
      set({
        ...derive(entries, get()),
        scanning: false,
        progress: null,
        permission: 'granted',
        cacheLoaded: true,
      });
    } catch (error) {
      set({
        scanning: false,
        progress: null,
        error: error instanceof Error ? error.message : 'Could not read your library.',
      });
    }
  },

  sync: async () => {
    const state = get();
    if (!state.folder || state.scanning || syncing) return;
    syncing = true;
    try {
      const next = await syncFolder(state.folder, state.entries, state.excludedFolders);
      if (next) {
        await saveLibraryCache(state.folder, next);
        set(derive(next, state));
      }
    } catch {
      // A folder that is briefly unreadable is not worth an error banner.
    } finally {
      syncing = false;
    }
  },

  setView: (view) => set({ view }),

  hideTrack: async (track) => {
    const state = get();
    const next = { ...state, hidden: [...state.hidden, track.uri] };
    set({ hidden: next.hidden });
    savePrefs(next);
    set(derive(state.entries, next));
  },

  unhideTrack: async (track) => {
    const state = get();
    const next = { ...state, hidden: state.hidden.filter((uri) => uri !== track.uri) };
    set({ hidden: next.hidden });
    savePrefs(next);
    set(derive(state.entries, next));
  },

  restoreHidden: async () => {
    const state = get();
    const next = { ...state, hidden: [] };
    set({ hidden: [] });
    savePrefs(next);
    set(derive(state.entries, next));
  },

  deleteFile: async (track) => {
    try {
      new File(track.uri).delete();
    } catch {
      set({ error: 'Could not delete that file.' });
      return;
    }
    const state = get();
    const entries = state.entries.filter((entry) => entry.uri !== track.uri);
    await saveLibraryCache(state.folder ?? 'media-store', entries);
    set(derive(entries, state));
  },

  setMetadata: async (track, patch) => {
    const state = get();
    const current = { ...state.overrides[track.uri] };
    for (const [key, value] of Object.entries(patch)) {
      if (value) current[key as keyof TrackOverrides] = value;
      else delete current[key as keyof TrackOverrides];
    }
    const overrides = { ...state.overrides };
    if (Object.keys(current).length === 0) delete overrides[track.uri];
    else overrides[track.uri] = current;
    const next = { ...state, overrides };
    set({ overrides });
    savePrefs(next);
    set(derive(state.entries, next));
  },

  setMinDuration: async (seconds) => {
    const state = get();
    const next = { ...state, minDuration: seconds };
    set({ minDuration: seconds });
    savePrefs(next);
    set(derive(state.entries, next));
  },

  createPlaylist: (name) => {
    const state = get();
    const playlist: Playlist = {
      id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || 'Playlist',
      uris: [],
    };
    const next = { ...state, playlists: [...state.playlists, playlist] };
    set({ playlists: next.playlists });
    savePrefs(next);
    return playlist.id;
  },

  addToPlaylist: async (id, track) => {
    const state = get();
    const playlists = state.playlists.map((playlist) =>
      playlist.id === id && !playlist.uris.includes(track.uri)
        ? { ...playlist, uris: [...playlist.uris, track.uri] }
        : playlist,
    );
    const next = { ...state, playlists };
    set({ playlists });
    savePrefs(next);
  },

  removeFromPlaylist: async (id, track) => {
    const state = get();
    const playlists = state.playlists.map((playlist) =>
      playlist.id === id
        ? { ...playlist, uris: playlist.uris.filter((uri) => uri !== track.uri) }
        : playlist,
    );
    const next = { ...state, playlists };
    set({ playlists });
    savePrefs(next);
  },

  deletePlaylist: async (id) => {
    const state = get();
    const next = { ...state, playlists: state.playlists.filter((playlist) => playlist.id !== id) };
    set({ playlists: next.playlists });
    savePrefs(next);
  },
}));
