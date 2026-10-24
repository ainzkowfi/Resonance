import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BOTTOM_BAR_SPACE } from '../../components/bottomBar';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Touch } from '../../components/Touch';
import { TrackRow } from '../../components/TrackRow';
import { formatDuration } from '../../lib/format';
import { fuzzySearch } from '../../lib/fuzzy';
import { searchCatalog, toCatalogTrack, type ITunesTrack } from '../../metadata/itunes';
import { useLibraryStore } from '../../store/library';
import { usePlayerStore } from '../../store/player';
import { openPlayer } from '../../store/playerSurface';
import { font, HIT, palette, radius } from '../../theme';

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const playTracks = usePlayerStore((state) => state.playTracks);
  const libraryTracks = useLibraryStore((state) => state.tracks);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ITunesTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestId = useRef(0);
  const inputRef = useRef<TextInputInstance>(null);

  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(timer);
    }, []),
  );

  useEffect(() => {
    const term = query.trim();
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      if (term.length < 2) {
        setResults([]);
        setError(undefined);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const found = await searchCatalog(term, 30);
        if (requestId.current !== id) return;
        const ranked = fuzzySearch(
          term,
          found,
          (item) => `${item.trackName} ${item.artistName} ${item.collectionName ?? ''}`,
        );
        setResults(ranked.length > 0 ? ranked : found);
        setError(undefined);
      } catch {
        if (requestId.current !== id) return;
        setError('Could not reach the catalog. Check your connection.');
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [query]);

  const localTracks = useMemo(
    () =>
      fuzzySearch(
        query,
        libraryTracks,
        (track) => `${track.title} ${track.artist} ${track.album ?? ''}`,
      ).slice(0, 8),
    [libraryTracks, query],
  );

  const tracks = useMemo(() => results.map(toCatalogTrack), [results]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader title="Search" subtitle="Stream a 30 second preview" />

      <View style={styles.searchWrap}>
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={palette.textFaint} />
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Songs, artists, albums"
            placeholderTextColor={palette.textFaint}
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
          {loading ? <ActivityIndicator size="small" color={palette.accent} /> : null}
        </View>
      </View>

      {error ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </Animated.View>
      ) : null}

      <Animated.FlatList
        data={tracks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          localTracks.length > 0 ? (
            <View>
              <Text style={styles.sectionLabel}>On this device</Text>
              {localTracks.map((item, index) => (
                <TrackRow
                  key={item.id}
                  track={item}
                  subtitle={[item.artist, item.album].filter(Boolean).join(' · ')}
                  onPress={() => {
                    playTracks(localTracks, index);
                    openPlayer();
                  }}
                />
              ))}
              {tracks.length > 0 ? <Text style={styles.sectionLabel}>Catalog previews</Text> : null}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          localTracks.length > 0 || loading || error ? (
            <View />
          ) : query.trim().length >= 2 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>Nothing found for “{query.trim()}”.</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Find something to play</Text>
              <Text style={styles.emptyText}>
                Search your device or the catalog. Besides previews, every result also brings lyrics,
                tags and similar songs.
              </Text>
            </View>
          )
        }
        renderItem={({ item, index }) => (
          <Animated.View entering={FadeInDown.delay(Math.min(index, 12) * 25).duration(220)}>
            <TrackRow
              track={item}
              subtitle={[item.artist, item.album].filter(Boolean).join(' · ')}
              onPress={() => {
                playTracks(tracks, index);
                openPlayer();
              }}
              trailing={
                <View style={styles.trailing}>
                  <View style={styles.previewBadge}>
                    <Text style={styles.previewText}>PREVIEW</Text>
                  </View>
                  <Text style={styles.duration}>{formatDuration(item.duration)}</Text>
                </View>
              }
            />
            <View style={styles.rowActions}>
              <Touch
                style={styles.rowAction}
                haptic="none"
                onPress={() => router.push({ pathname: '/track/[id]', params: { id: item.id } })}
                accessibilityLabel="Track details"
              >
                <Ionicons name="information-circle-outline" size={18} color={palette.textDim} />
                <Text style={styles.rowActionText}>Details & lyrics</Text>
              </Touch>
            </View>
          </Animated.View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: HIT.comfortable,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
  },
  input: {
    flex: 1,
    ...font.body,
    color: palette.text,
    padding: 0,
  },
  listContent: {
    paddingBottom: BOTTOM_BAR_SPACE + 24,
  },
  sectionLabel: {
    ...font.caption,
    color: palette.textFaint,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 4,
  },
  previewBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(0,211,167,0.16)',
  },
  previewText: {
    ...font.caption,
    fontSize: 9,
    color: palette.accentAlt,
  },
  duration: {
    ...font.label,
    color: palette.textFaint,
  },
  rowActions: {
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  rowAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingRight: 8,
  },
  rowActionText: {
    ...font.label,
    color: palette.textDim,
  },
  error: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,77,109,0.12)',
  },
  errorText: {
    ...font.label,
    color: palette.danger,
  },
  empty: {
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: {
    ...font.title,
    color: palette.text,
  },
  emptyText: {
    ...font.body,
    fontWeight: '500',
    color: palette.textFaint,
    textAlign: 'center',
    lineHeight: 21,
  },
});
