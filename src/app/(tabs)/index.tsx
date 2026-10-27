import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { FadeIn, FadeInDown, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Artwork } from '../../components/Artwork';
import { BOTTOM_BAR_SPACE } from '../../components/bottomBar';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Segmented } from '../../components/Segmented';
import { Touch } from '../../components/Touch';
import { TrackRow } from '../../components/TrackRow';
import { resolvePlaylist, useLibraryStore } from '../../store/library';
import { usePlayerStore } from '../../store/player';
import { font, HIT, palette, radius } from '../../theme';
import type { Track } from '../../types/track';

const VIEWS = [
  { value: 'tracks' as const, label: 'Tracks' },
  { value: 'albums' as const, label: 'Albums' },
  { value: 'artists' as const, label: 'Artists' },
  { value: 'playlists' as const, label: 'Playlists' },
];

type TrackSort = 'title' | 'artist' | 'album';

const SORTS: { value: TrackSort; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
];

function sortTracks(tracks: Track[], mode: TrackSort): Track[] {
  const sorted = [...tracks];
  sorted.sort((a, b) => {
    if (mode === 'title') {
      return a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist);
    }
    if (mode === 'album') {
      return (
        (a.album ?? '').localeCompare(b.album ?? '') ||
        a.artist.localeCompare(b.artist) ||
        (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
        (a.trackNumber ?? 0) - (b.trackNumber ?? 0)
      );
    }
    return (
      a.artist.localeCompare(b.artist) ||
      (a.album ?? '').localeCompare(b.album ?? '') ||
      (a.discNumber ?? 0) - (b.discNumber ?? 0) ||
      (a.trackNumber ?? 0) - (b.trackNumber ?? 0) ||
      a.title.localeCompare(b.title)
    );
  });
  return sorted;
}

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const {
    permission,
    tracks,
    entries,
    albums,
    artists,
    playlists,
    overrides,
    scanning,
    progress,
    error,
    view,
    folder,
    hydrate,
    request,
    pickFolder,
    setView,
  } = useLibraryStore();
  const playTracks = usePlayerStore((state) => state.playTracks);
  const router = useRouter();
  const [sort, setSort] = useState<TrackSort>('artist');
  const sortedTracks = useMemo(() => sortTracks(tracks, sort), [tracks, sort]);
  // The docked player and the tab bar both live below this list, and the tab bar
  // grows by the gesture inset, so the reserved space has to include it or the
  // last row sits behind the bar.
  const listStyle = useMemo(
    () => [styles.listContent, { paddingBottom: BOTTOM_BAR_SPACE + insets.bottom + 24 }],
    [insets.bottom],
  );

  const playlistRows = useMemo(
    () =>
      playlists.map((playlist) => ({
        playlist,
        tracks: resolvePlaylist(playlist, entries, overrides),
      })),
    [playlists, entries, overrides],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // A folder the user granted last time is the better source, so try it
    // before falling back to the system media index.
    void (async () => {
      await hydrate();
      if (useLibraryStore.getState().permission === 'unknown') await request();
    })();
  }, [hydrate, request]);

  const stepView = useCallback(
    (direction: number) => {
      const index = VIEWS.findIndex((option) => option.value === useLibraryStore.getState().view);
      const next = VIEWS[Math.min(VIEWS.length - 1, Math.max(0, index + direction))];
      if (next) setView(next.value);
    },
    [setView],
  );

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-24, 24])
        .failOffsetY([-16, 16])
        .onEnd((event) => {
          if (Math.abs(event.translationX) < 60) return;
          runOnJS(stepView)(event.translationX < 0 ? 1 : -1);
        }),
    [stepView],
  );

  const header = (
    <ScreenHeader
      title="Resonance"
      subtitle={
        tracks.length > 0
          ? `${tracks.length} tracks${folder ? ' in your folder' : ' on this device'}`
          : folder
            ? scanning
              ? 'Reading your folder…'
              : 'No tracks found in your folder'
            : 'Your music, on your device'
      }
      action={
        tracks.length > 0
          ? {
              icon: 'play',
              label: 'Play everything',
              onPress: () => {
                playTracks(sortedTracks);
              },
            }
          : undefined
      }
    />
  );

  if (tracks.length === 0) {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        {header}
        <PermissionCard
          permission={permission}
          scanning={scanning}
          progress={progress}
          error={error}
          hasFolder={Boolean(folder)}
          onRequest={() => void request()}
          onPickFolder={() => void pickFolder()}
        />
      </View>
    );
  }

  return (
    <GestureDetector gesture={swipe}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        {header}
        <View style={styles.toolbar}>
          <Segmented options={VIEWS} value={view} onChange={setView} />
          <View style={styles.toolbarRight}>
            {scanning ? (
              <Text style={styles.scanning}>
                Scanning… {progress ? `${progress.done}/${progress.total}` : ''}
              </Text>
            ) : null}
            <Touch
              style={styles.iconButton}
              haptic="none"
              accessibilityLabel="Choose music folder"
              onPress={() => void pickFolder()}
            >
              <Ionicons name="folder-open-outline" size={20} color={palette.textDim} />
            </Touch>
          </View>
        </View>

        {view === 'tracks' ? (
          <View style={styles.sortRow}>
            <Text style={styles.sortLabel}>SORT</Text>
            <Segmented options={SORTS} value={sort} onChange={setSort} />
          </View>
        ) : null}

        {view === 'tracks' ? (
          <Animated.FlatList
            data={sortedTracks}
            keyExtractor={(item) => item.id}
            contentContainerStyle={listStyle}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={<Empty label="No audio files found on this device." />}
            renderItem={({ item, index }) => (
              <Animated.View entering={FadeInDown.delay(Math.min(index, 12) * 30).duration(240)}>
                <TrackRow
                  track={item}
                  onPress={() => {
                    playTracks(sortedTracks, index);
                  }}
                />
              </Animated.View>
            )}
          />
        ) : null}

        {view === 'albums' ? (
          <Animated.FlatList
            data={albums}
            keyExtractor={(item) => item.key}
            numColumns={2}
            columnWrapperStyle={styles.column}
            contentContainerStyle={listStyle}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={<Empty label="No albums yet." />}
            renderItem={({ item, index }) => (
              <Animated.View
                entering={FadeInDown.delay(Math.min(index, 12) * 30).duration(240)}
                style={styles.albumCell}
              >
                <Touch
                  style={styles.album}
                  haptic="none"
                  onPress={() => {
                    playTracks(item.tracks);
                  }}
                >
                  <Artwork uri={item.artwork} size={160} borderRadius={radius.md} />
                  <Text style={styles.albumName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.albumArtist} numberOfLines={1}>
                    {item.artist}
                  </Text>
                </Touch>
              </Animated.View>
            )}
          />
        ) : null}

        {view === 'artists' ? (
          <Animated.FlatList
            data={artists}
            keyExtractor={(item) => item.name}
            contentContainerStyle={listStyle}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={<Empty label="No artists yet." />}
            renderItem={({ item, index }) => (
              <Animated.View entering={FadeInDown.delay(Math.min(index, 12) * 30).duration(240)}>
                <Touch
                  style={styles.artist}
                  haptic="none"
                  onPress={() => {
                    playTracks(item.tracks);
                  }}
                >
                  <Artwork uri={item.artwork} size={48} borderRadius={radius.pill} />
                  <View style={styles.artistText}>
                    <Text style={styles.artistName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.artistCount}>{item.tracks.length} tracks</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={palette.textFaint} />
                </Touch>
              </Animated.View>
            )}
          />
        ) : null}
        {view === 'playlists' ? (
          <Animated.FlatList
            data={playlistRows}
            keyExtractor={(item) => item.playlist.id}
            contentContainerStyle={listStyle}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <Empty label="No playlists yet. Long-press a song, then Add to playlist." />
            }
            renderItem={({ item, index }) => (
              <Animated.View entering={FadeInDown.delay(Math.min(index, 12) * 30).duration(240)}>
                <Touch
                  style={styles.artist}
                  haptic="none"
                  onPress={() =>
                    router.push({
                      pathname: '/playlist/[id]',
                      params: { id: item.playlist.id },
                    })
                  }
                >
                  <Artwork uri={item.tracks[0]?.artwork} size={48} borderRadius={radius.md} />
                  <View style={styles.artistText}>
                    <Text style={styles.artistName} numberOfLines={1}>
                      {item.playlist.name}
                    </Text>
                    <Text style={styles.artistCount}>
                      {item.tracks.length === 1 ? '1 track' : `${item.tracks.length} tracks`}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={palette.textFaint} />
                </Touch>
              </Animated.View>
            )}
          />
        ) : null}
      </View>
    </GestureDetector>
  );
}

function PermissionCard({
permission,
scanning,
progress,
error,
hasFolder,
onRequest,
onPickFolder,
}: {
permission: string;
scanning: boolean;
progress: { done: number; total: number } | null;
error?: string;
hasFolder: boolean;
onRequest: () => void;
onPickFolder: () => void;
}) {
const denied = permission === 'denied';

return (
  <Animated.ScrollView
    entering={FadeIn.duration(260)}
    contentContainerStyle={styles.cardWrap}
    showsVerticalScrollIndicator={false}
  >
    <View style={styles.card}>
      <View style={styles.cardIcon}>
        <Ionicons name="musical-notes" size={30} color={palette.accent} />
      </View>
      <Text style={styles.cardTitle}>Point Resonance at your music</Text>
      <Text style={styles.cardBody}>
        Pick the folder your downloads live in. Titles, artists, albums, cover art and lyrics are
        read straight from each file — including any <Text style={styles.mono}>.lrc</Text> sitting
        next to it. MP3, FLAC, M4A, OGG, Opus, WAV and AIFF all work, and nothing is uploaded.
      </Text>

      {error ? <Text style={styles.cardError}>{error}</Text> : null}

      {scanning ? (
        <Text style={styles.cardBody}>
          Scanning {progress ? `${progress.done} of ${progress.total}` : 'your folder'}…
        </Text>
      ) : (
        <>
          <Touch style={styles.cta} onPress={onPickFolder}>
            <Ionicons name="folder-open" size={18} color="#fff" />
            <Text style={styles.ctaText}>{hasFolder ? 'Choose a different folder' : 'Choose folder'}</Text>
          </Touch>
          <Touch
            style={styles.ctaSecondary}
            haptic="none"
            onPress={() => {
              if (denied) void Linking.openSettings();
              else onRequest();
            }}
          >
            <Text style={styles.ctaSecondaryText}>
              {denied ? 'Open system settings' : 'Use the device music library instead'}
            </Text>
          </Touch>
        </>
      )}
    </View>
  </Animated.ScrollView>
);
}

function Empty({ label }: { label: string }) {
return (
  <View style={styles.empty}>
    <Text style={styles.emptyText}>{label}</Text>
  </View>
);
}

const styles = StyleSheet.create({
root: {
  flex: 1,
  backgroundColor: palette.bg,
},
toolbar: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingHorizontal: 16,
  paddingBottom: 12,
},
scanning: {
  ...font.label,
  color: palette.accentAlt,
},
toolbarRight: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
},
sortRow: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 10,
  paddingHorizontal: 16,
  paddingBottom: 10,
},
sortLabel: {
  ...font.caption,
  fontWeight: '700',
  letterSpacing: 1.2,
  color: palette.textFaint,
},
iconButton: {
  width: HIT.min,
  height: HIT.min,
  alignItems: 'center',
  justifyContent: 'center',
},
listContent: {
  paddingTop: 4,
},
column: {
  gap: 12,
  paddingHorizontal: 16,
},
albumCell: {
  flex: 1,
  marginBottom: 16,
},
album: {
  gap: 6,
},
albumName: {
  ...font.body,
  fontSize: 15,
  color: palette.text,
},
albumArtist: {
  ...font.label,
  fontWeight: '500',
  color: palette.textDim,
},
artist: {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
  paddingHorizontal: 16,
  paddingVertical: 8,
  minHeight: 64,
},
artistText: {
  flex: 1,
  gap: 3,
},
artistName: {
  ...font.body,
  fontSize: 16,
  color: palette.text,
},
artistCount: {
  ...font.label,
  fontWeight: '500',
  color: palette.textDim,
},
cardWrap: {
  padding: 20,
},
card: {
  backgroundColor: palette.surface,
  borderRadius: radius.lg,
  padding: 24,
  gap: 14,
  alignItems: 'flex-start',
},
cardIcon: {
  width: 56,
  height: 56,
  borderRadius: radius.md,
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: palette.selection,
},
cardTitle: {
  ...font.title,
  color: palette.text,
},
cardBody: {
  ...font.body,
  fontWeight: '500',
  color: palette.textDim,
  lineHeight: 22,
},
cardError: {
  ...font.label,
  color: palette.danger,
},
cta: {
  height: HIT.comfortable,
  paddingHorizontal: 24,
  borderRadius: radius.pill,
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'row',
  gap: 8,
  backgroundColor: palette.accent,
},
ctaText: {
  ...font.label,
  color: palette.bg,
},
ctaSecondary: {
  minHeight: HIT.min,
  justifyContent: 'center',
},
ctaSecondaryText: {
  ...font.label,
  fontWeight: '500',
  color: palette.textDim,
},
mono: {
  color: palette.accentAlt,
},
empty: {
  padding: 40,
  alignItems: 'center',
},
emptyText: {
  ...font.body,
  fontWeight: '500',
  color: palette.textFaint,
},
});
