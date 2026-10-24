import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenHeader } from '../components/ScreenHeader';
import { Touch } from '../components/Touch';
import { TrackRow } from '../components/TrackRow';
import { applyLibraryFilter } from '../lib/filter';
import { formatDuration } from '../lib/format';
import { useLibraryStore } from '../store/library';
import { font, palette, radius } from '../theme';

export default function HiddenScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const entries = useLibraryStore((state) => state.entries);
  const hiddenUris = useLibraryStore((state) => state.hidden);
  const overrides = useLibraryStore((state) => state.overrides);
  const minDuration = useLibraryStore((state) => state.minDuration);
  const unhideTrack = useLibraryStore((state) => state.unhideTrack);
  const restoreHidden = useLibraryStore((state) => state.restoreHidden);

  const tracks = useMemo(() => {
    const hidden = new Set(hiddenUris);
    return applyLibraryFilter(
      entries.filter((entry) => hidden.has(entry.uri)),
      { hidden: [], minDuration, overrides },
    );
  }, [entries, hiddenUris, minDuration, overrides]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Hidden tracks"
        subtitle={hiddenUris.length === 0 ? 'Nothing hidden' : `${hiddenUris.length} hidden`}
        back
        action={
          hiddenUris.length > 0
            ? { icon: 'refresh', label: 'Restore all', onPress: () => void restoreHidden() }
            : undefined
        }
      />

      {tracks.length === 0 ? (
        <Animated.View entering={FadeIn.duration(220)} style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {hiddenUris.length === 0 ? 'Nothing hidden' : 'Filtered out'}
          </Text>
          <Text style={styles.emptyBody}>
            {hiddenUris.length === 0
              ? 'Hide a track from its long-press menu to move it here.'
              : `Hidden tracks under ${formatDuration(minDuration)} stay off this list while the short-track filter is on.`}
          </Text>
        </Animated.View>
      ) : (
        <FlatList
          data={tracks}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <TrackRow
              track={item}
              onPress={() => void unhideTrack(item)}
              onLongPress={() => void unhideTrack(item)}
              trailing={
                <Touch
                  style={styles.restore}
                  onPress={() => void unhideTrack(item)}
                  accessibilityLabel={`Restore ${item.title}`}
                >
                  <Text style={styles.restoreText}>Restore</Text>
                </Touch>
              }
            />
          )}
        />
      )}
      <Touch style={[styles.close, { bottom: insets.bottom + 16 }]} onPress={() => router.back()}>
        <Text style={styles.closeText}>Done</Text>
      </Touch>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  list: {
    paddingBottom: 120,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
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
  restore: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(107,78,255,0.22)',
  },
  restoreText: {
    ...font.label,
    fontWeight: '600',
    color: palette.accent,
  },
  close: {
    position: 'absolute',
    alignSelf: 'center',
    height: 44,
    paddingHorizontal: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.text,
  },
  closeText: {
    ...font.label,
    fontWeight: '600',
    color: palette.bgElevated,
  },
});
