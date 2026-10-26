import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '../../components/ScreenHeader';
import { Touch } from '../../components/Touch';
import { TrackRow } from '../../components/TrackRow';
import { formatDuration } from '../../lib/format';
import { resolvePlaylist, useLibraryStore } from '../../store/library';
import { usePlayerStore } from '../../store/player';
import { font, palette, radius } from '../../theme';

export default function PlaylistScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  // A repeated param arrives as an array; the track screen unwraps it too.
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const entries = useLibraryStore((state) => state.entries);
  const overrides = useLibraryStore((state) => state.overrides);
  const playlists = useLibraryStore((state) => state.playlists);
  const removeFromPlaylist = useLibraryStore((state) => state.removeFromPlaylist);
  const deletePlaylist = useLibraryStore((state) => state.deletePlaylist);
  const playTracks = usePlayerStore((state) => state.playTracks);

  const playlist = playlists.find((item) => item.id === id);
  const tracks = useMemo(
    () => (playlist ? resolvePlaylist(playlist, entries, overrides) : []),
    [playlist, entries, overrides],
  );
  const total = useMemo(
    () => tracks.reduce((sum, track) => sum + (track.duration || 0), 0),
    [tracks],
  );

  const erase = () => {
    if (!playlist) return;
    Alert.alert('Delete playlist?', `${playlist.name} will be removed. The files stay on your device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void deletePlaylist(playlist.id);
          router.back();
        },
      },
    ]);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader
        title={playlist?.name ?? 'Playlist'}
        subtitle={
          tracks.length > 0
            ? `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} · ${formatDuration(total)}`
            : 'No tracks yet'
        }
        back
        action={
          tracks.length > 0
            ? {
                icon: 'play',
                label: 'Play playlist',
                onPress: () => {
                playTracks(tracks);
                },
              }
            : undefined
        }
      />

      {!playlist ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Playlist not found</Text>
        </View>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 120 }]}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Nothing here yet</Text>
              <Text style={styles.emptyBody}>
                Long-press a song in your library and choose Add to playlist.
              </Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <TrackRow
              track={item}
              onPress={() => {
                playTracks(tracks, index);
              }}
              onLongPress={() => void removeFromPlaylist(playlist.id, item)}
              trailing={
                <Touch
                  style={styles.remove}
                  haptic="none"
                  accessibilityLabel={`Remove ${item.title} from playlist`}
                  onPress={() => void removeFromPlaylist(playlist.id, item)}
                >
                  <Ionicons name="close" size={18} color={palette.textFaint} />
                </Touch>
              }
            />
          )}
          ListFooterComponent={
            <Touch style={styles.erase} haptic="medium" onPress={erase}>
              <Ionicons name="trash-outline" size={16} color={palette.danger} />
              <Text style={styles.eraseText}>Delete playlist</Text>
            </Touch>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  list: {
    paddingTop: 4,
  },
  remove: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingVertical: 48,
    gap: 6,
  },
  emptyTitle: {
    ...font.body,
    fontSize: 17,
    color: palette.text,
  },
  emptyBody: {
    ...font.label,
    fontWeight: '500',
    color: palette.textDim,
    textAlign: 'center',
  },
  erase: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 18,
    marginTop: 24,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
  },
  eraseText: {
    ...font.label,
    color: palette.danger,
  },
});
