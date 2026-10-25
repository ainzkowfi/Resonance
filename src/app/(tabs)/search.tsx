import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BOTTOM_BAR_SPACE } from '../../components/bottomBar';
import { Glass } from '../../components/Glass';
import { ScreenHeader } from '../../components/ScreenHeader';
import { TrackRow } from '../../components/TrackRow';
import { fuzzySearch } from '../../lib/fuzzy';
import { useLibraryStore } from '../../store/library';
import { usePlayerStore } from '../../store/player';
import { font, HIT, palette, radius } from '../../theme';

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const playTracks = usePlayerStore((state) => state.playTracks);
  const libraryTracks = useLibraryStore((state) => state.tracks);
  const [query, setQuery] = useState('');
  const inputRef = useRef<TextInputInstance>(null);

  const tracks = useMemo(
    () =>
      fuzzySearch(
        query,
        libraryTracks,
        (track) => `${track.title} ${track.artist} ${track.album ?? ''}`,
      ),
    [libraryTracks, query],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader title="Search" subtitle="Find music on this device" />

      <View style={styles.searchWrap}>
        <Glass radius={radius.md} intensity={64} style={styles.search}>
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
        </Glass>
      </View>

      {query.trim().length > 0 ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
          <Text style={styles.sectionLabel}>
            {tracks.length === 1 ? '1 track' : `${tracks.length} tracks`}
          </Text>
        </Animated.View>
      ) : null}

      <FlatList
        data={tracks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: BOTTOM_BAR_SPACE + insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {query.trim() ? 'No matching tracks' : 'Search your music'}
            </Text>
            <Text style={styles.emptyText}>
              {query.trim()
                ? `Nothing found for “${query.trim()}”.`
                : 'Search the songs, artists and albums stored on this device.'}
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <Animated.View entering={FadeInDown.delay(Math.min(index, 12) * 20).duration(180)}>
            <TrackRow
              track={item}
              onPress={() => {
                playTracks(tracks, index);
              }}
            />
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
  },
  input: {
    flex: 1,
    ...font.body,
    color: palette.text,
    padding: 0,
  },
  listContent: {
    paddingTop: 2,
  },
  sectionLabel: {
    ...font.caption,
    color: palette.textFaint,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginHorizontal: 16,
    marginBottom: 4,
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
