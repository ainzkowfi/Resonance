import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { activeLineIndex, parseLrc, parsePlainLyrics, type LyricLine } from '../lib/lrc';
import { usePlayerStore } from '../store/player';
import { font, palette } from '../theme';
import type { Lyrics } from '../types/track';

const LINE_HEIGHT = 54;
const CONTENT_PADDING = 120;

export interface LyricsViewProps {
  lyrics?: Lyrics;
  /** Seconds. Defaults to the live player position. */
  position?: number;
  onSeek?: (seconds: number) => void;
  /**
   * Set false inside a parent ScrollView: a virtualised list nested in a plain
   * ScrollView breaks windowing, so render the lines inline instead.
   */
  scroll?: boolean;
}

/**
 * Synced lyrics with a moving highlight and tap-to-seek.
 *
 * When there is no synced lyric we fall back to the plain text, still tappable
 * only if we know the timing, which we do not, so plain lyrics are read-only.
 */
export function LyricsView({ lyrics, position, onSeek, scroll = true }: LyricsViewProps) {
  const listRef = useRef<FlatList<LyricLine>>(null);
  const [centered, setCentered] = useState(false);
  const livePosition = usePlayerStore((state) => state.position);
  const current = position ?? livePosition;

  const syncedSource = lyrics?.synced;
  const plainSource = lyrics?.plain;

  const synced = useMemo(() => (syncedSource ? parseLrc(syncedSource) : []), [syncedSource]);
  const plain = useMemo(() => (plainSource ? parsePlainLyrics(plainSource) : []), [plainSource]);

  const active = useMemo(() => activeLineIndex(synced, current), [synced, current]);

  useEffect(() => {
    if (!centered || active < 0 || !listRef.current) return;
    listRef.current.scrollToIndex({ index: active, animated: true, viewPosition: 0.5 });
  }, [active, centered]);

  const centerInitial = useCallback(() => {
    if (centered) return;
    if (active >= 0) {
      // First paint should already sit at the line matching the song position.
      // The list stays transparent until this jump lands, so there is no
      // visible scroll from the top when lyrics are opened mid-song.
      listRef.current?.scrollToIndex({ index: active, animated: false, viewPosition: 0.5 });
    }
    requestAnimationFrame(() => setCentered(true));
  }, [active, centered]);

  if (!lyrics || (synced.length === 0 && plain.length === 0)) {
    return (
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(120)} style={styles.empty}>
        <Text style={styles.emptyTitle}>No lyrics found</Text>
        <Text style={styles.emptyBody}>Nobody has synced this track yet.</Text>
      </Animated.View>
    );
  }

  if (synced.length === 0) {
    const lines = plain.map((line, index) => (
      <Text key={`${index}-${line}`} style={styles.plainLine}>
        {line}
      </Text>
    ));

    if (!scroll) return <View style={styles.inlineContent}>{lines}</View>;

    return (
      <Animated.ScrollView
        entering={FadeIn.duration(220)}
        contentContainerStyle={styles.plainContent}
        showsVerticalScrollIndicator={false}
      >
        {lines}
      </Animated.ScrollView>
    );
  }

  if (!scroll) {
    return (
      <View style={styles.inlineContent}>
        {synced.map((item, index) => (
          <Text
            key={`${item.time}-${index}`}
            onPress={onSeek ? () => onSeek(item.time) : undefined}
            accessibilityRole={onSeek ? 'button' : undefined}
            accessibilityLabel={onSeek ? `Seek to ${Math.floor(item.time / 60)}:${String(Math.floor(item.time % 60)).padStart(2, '0')}, ${item.text}` : undefined}
            style={[styles.line, index === active ? styles.lineActive : styles.lineIdle]}
          >
            {item.text || '♪'}
          </Text>
        ))}
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={synced}
      keyExtractor={(item, index) => `${item.time}-${index}`}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.content}
      style={centered ? undefined : styles.hidden}
      onLayout={centerInitial}
      getItemLayout={(_, index) => ({
        length: LINE_HEIGHT,
        offset: CONTENT_PADDING + LINE_HEIGHT * index,
        index,
      })}
      initialNumToRender={12}
      windowSize={7}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        listRef.current?.scrollToOffset({
          offset: CONTENT_PADDING + index * averageItemLength,
          animated: true,
        });
      }}
      renderItem={({ item, index }) => {
        const isActive = index === active;
        return (
          <Animated.Text
            onPress={onSeek ? () => onSeek(item.time) : undefined}
            accessibilityRole={onSeek ? 'button' : undefined}
            accessibilityLabel={onSeek ? `Seek to ${Math.floor(item.time / 60)}:${String(Math.floor(item.time % 60)).padStart(2, '0')}, ${item.text}` : undefined}
            style={[styles.line, isActive ? styles.lineActive : styles.lineIdle]}
          >
            {item.text || '♪'}
          </Animated.Text>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: CONTENT_PADDING,
    paddingHorizontal: 24,
  },
  plainContent: {
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  inlineContent: {
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  hidden: {
    opacity: 0,
  },
  line: {
    ...font.title,
    minHeight: LINE_HEIGHT,
    lineHeight: 30,
    paddingVertical: 12,
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  lineActive: {
    color: palette.text,
  },
  lineIdle: {
    color: palette.textFaint,
  },
  plainLine: {
    ...font.body,
    fontSize: 16,
    color: palette.textDim,
    lineHeight: 26,
    paddingVertical: 2,
    textAlign: 'center',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 6,
  },
  emptyTitle: {
    ...font.title,
    color: palette.text,
  },
  emptyBody: {
    ...font.body,
    color: palette.textFaint,
  },
});
