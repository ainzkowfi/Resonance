import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  FlatList,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTrackLyrics } from '../hooks/useTrackLyrics';
import { formatDuration } from '../lib/format';
import { usePlayerStore } from '../store/player';
import { usePlayerSurface } from '../store/playerSurface';
import { font, HIT, motion, palette, radius } from '../theme';
import type { Track } from '../types/track';
import { AmbientBackground } from './AmbientBackground';
import { Artwork } from './Artwork';
import { PLAYER_BAR_HEIGHT } from './bottomBar';
import { EqBars } from './EqBars';
import { LyricsView } from './LyricsView';
import { ProgressBar, type ProgressBarProps } from './ProgressBar';
import { Touch } from './Touch';

type LyricsMode = 'off' | 'over';

const absoluteFill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const MINI_ART = 44;
const MINI_PAD = 10;
/** Drag distance that peels the lyrics away before the dock starts to shrink. */
const LYRICS_REVEAL_DISTANCE = 140;

/**
 * The player is one surface that morphs between the docked bar and full screen,
 * so opening it is a single shared value instead of a navigation push. The
 * artwork is laid out at full size and transformed down to the bar: transforms
 * stay on the UI thread, and the image never re-decodes mid-flight.
 */
export function PlayerSurface({ bottom = 0 }: { bottom?: number }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const track = usePlayerStore((state) => state.currentTrack);
  const queue = usePlayerStore((state) => state.queue);
  const queueIndex = usePlayerStore((state) => state.queueIndex);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const repeat = usePlayerStore((state) => state.repeat);
  const toggle = usePlayerStore((state) => state.toggle);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const toggleRepeat = usePlayerStore((state) => state.toggleRepeat);
  const seek = usePlayerStore((state) => state.seek);

  const expanded = usePlayerSurface((state) => state.expanded);
  const open = usePlayerSurface((state) => state.open);
  const close = usePlayerSurface((state) => state.close);

  const [lyricsMode, setLyricsMode] = useState<LyricsMode>('off');
  const [stage, setStage] = useState({ x: 0, y: 0, size: 0, top: 0, height: 0 });
  const carouselRef = useRef<FlatList<Track>>(null);
  const carouselSync = useRef<{ index: number; id: string | null }>({ index: -1, id: null });
  const reduceMotion = useReducedMotion();
  const lyrics = useTrackLyrics(track);

  const expand = useSharedValue(0);
  const dragX = useSharedValue(0);
  const shown = useSharedValue(0);
  const coverOpacity = useSharedValue(1);
  const lyricsOpacity = useSharedValue(1);

  useEffect(() => {
    expand.value = withSpring(expanded ? 1 : 0, motion.spring.smooth);
  }, [expanded, expand]);

  useEffect(() => {
    shown.value = withSpring(track ? 1 : 0, motion.spring.smooth);
  }, [track, shown]);

  useEffect(() => {
    coverOpacity.value = withTiming(lyricsMode === 'over' ? 0 : 1, {
      duration: motion.base,
    });
    lyricsOpacity.value = withTiming(lyricsMode === 'over' ? 1 : 0, {
      duration: motion.base,
    });
  }, [coverOpacity, lyricsMode, lyricsOpacity]);

  useEffect(() => {
    if (queue.length === 0) return;
    const index = Math.max(0, Math.min(queueIndex, queue.length - 1));
    const id = queue[index]?.id ?? null;
    if (carouselSync.current.index === index && carouselSync.current.id === id) return;
    carouselSync.current = { index, id };
    const frame = requestAnimationFrame(() => {
      carouselRef.current?.scrollToOffset({
        offset: index * width,
        animated: !expanded && !reduceMotion,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, queue, queueIndex, reduceMotion, width]);

  const collapse = useCallback(() => {
    close();
    setLyricsMode('off');
  }, [close]);

  const onCarouselEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const state = usePlayerStore.getState();
      if (state.queue.length === 0) return;
      const index = Math.max(
        0,
        Math.min(
          state.queue.length - 1,
          Math.round(event.nativeEvent.contentOffset.x / width),
        ),
      );
      const target = state.queue[index];
      if (!target) return;
      if (index === state.queueIndex && target.id === state.currentTrack?.id) return;
      carouselSync.current = { index, id: target.id };
      state.playAt(index);
    },
    [width],
  );

  const selectPage = useCallback(
    (index: number) => {
      const state = usePlayerStore.getState();
      const target = state.queue[index];
      if (!target) return;
      if (index !== state.queueIndex || target.id !== state.currentTrack?.id) {
        carouselSync.current = { index, id: target.id };
        state.playAt(index);
      }
      open();
    },
    [open],
  );

  const togglePage = useCallback((index: number) => {
    const state = usePlayerStore.getState();
    const target = state.queue[index];
    if (!target) return;
    if (index === state.queueIndex && target.id === state.currentTrack?.id) {
      state.toggle();
      return;
    }
    carouselSync.current = { index, id: target.id };
    state.playAt(index);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      collapse();
      return true;
    });
    return () => sub.remove();
  }, [expanded, collapse]);

  const onStageLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height: h } = event.nativeEvent.layout;
      const size = Math.min(width - 56, Math.round(h));
      const x = (width - size) / 2;
      const artY = y + (h - size) / 2;
      setStage((prev) =>
        prev.y === artY && prev.size === size && prev.x === x && prev.top === y && prev.height === h
          ? prev
          : { x, y: artY, size, top: y, height: h },
      );
    },
    [width],
  );

  const miniCy = height - bottom - PLAYER_BAR_HEIGHT + MINI_PAD + MINI_ART / 2;
  const miniCx = MINI_PAD + MINI_ART / 2;

  const artStyle = useAnimatedStyle(() => {
    const e = expand.value;
    const size = stage.size;
    const k = size > 0 ? MINI_ART / size : 1;
    return {
      // The docked carousel owns the artwork at rest; the full-size copy takes
      // over the instant the player starts expanding.
      opacity:
        (size > 0 ? 1 : 0) *
        interpolate(e, [0, 0.02], [0, 1], Extrapolation.CLAMP),
      borderRadius: interpolate(e, [0, 1], [radius.sm / k, radius.lg]),
      transform: [
        {
          translateX:
            interpolate(e, [0, 1], [miniCx - (stage.x + size / 2), 0]) +
            dragX.get(),
        },
        {
          translateY: interpolate(e, [0, 1], [miniCy - (stage.y + size / 2), 0]),
        },
        { scale: interpolate(e, [0, 1], [k, 1]) },
      ],
    };
  }, [stage, miniCx, miniCy, dragX, expand]);

  const miniArtStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expand.value, [0, 0.05], [1, 0], Extrapolation.CLAMP),
  }));

  const coverStyle = useAnimatedStyle(() => ({
    opacity: coverOpacity.value,
  }));

  const lyricsStyle = useAnimatedStyle(() => ({
    opacity: lyricsOpacity.value,
  }));

  const miniStyle = useAnimatedStyle(() => {
    const visible = shown.value;
    return {
      opacity: visible * interpolate(expand.value, [0, 0.45], [1, 0], 'clamp'),
      transform: [
        {
          translateY:
            (1 - visible) * (PLAYER_BAR_HEIGHT + 24) + expand.value * 12,
        },
      ],
    };
  });

  const fullStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expand.value, [0.35, 1], [0, 1], 'clamp'),
    transform: [{ translateY: interpolate(expand.value, [0, 1], [24, 0]) }],
  }));

  const bgStyle = useAnimatedStyle(() => ({
    opacity: interpolate(expand.value, [0, 0.6], [0, 1], 'clamp'),
  }));

  const artPan = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((event) => {
          if (Math.abs(event.translationX) > Math.abs(event.translationY)) {
            dragX.value = event.translationX;
          } else if (event.translationY > 0) {
            if (lyricsMode === 'over') {
              const dy = Math.max(0, event.translationY);
              const reveal = Math.min(1, dy / LYRICS_REVEAL_DISTANCE);
              coverOpacity.value = reveal;
              lyricsOpacity.value = 1 - reveal;
              const shrink = Math.max(0, dy - LYRICS_REVEAL_DISTANCE);
              expand.value = Math.max(0, 1 - shrink / (height * 0.4));
              return;
            }
            expand.value = Math.max(0, 1 - event.translationY / (height * 0.4));
          }
        })
        .onEnd((event) => {
          dragX.value = withSpring(0, motion.spring.snappy);
          if (Math.abs(event.translationX) > Math.abs(event.translationY)) {
            if (event.translationX < -70) scheduleOnRN(next);
            else if (event.translationX > 70) scheduleOnRN(previous);
          } else if (lyricsMode === 'over') {
            if (event.translationY > 90 || event.velocityY > 700) scheduleOnRN(collapse);
            else {
              coverOpacity.value = withTiming(0, { duration: motion.base });
              lyricsOpacity.value = withTiming(1, { duration: motion.base });
              expand.value = withSpring(1, motion.spring.smooth);
            }
          } else if (event.translationY > 110 || event.velocityY > 900) {
            scheduleOnRN(collapse);
          } else {
            expand.value = withSpring(1, motion.spring.smooth);
          }
        }),
    [collapse, coverOpacity, dragX, expand, height, lyricsMode, lyricsOpacity, next, previous],
  );

  const miniPan = usePanGesture({
    // Horizontal movement belongs to the native carousel; this gesture only
    // lifts the dock into the full player.
    activeOffsetY: [-16, 16],
    failOffsetX: [-24, 24],
    onUpdate: (event) => {
      if (event.translationY < 0) {
        expand.set(Math.min(1, -event.translationY / (height * 0.4)));
      }
    },
    onDeactivate: (event) => {
      const shouldOpen = !event.canceled && (expand.get() > 0.3 || event.velocityY < -600);
      if (shouldOpen) scheduleOnRN(open);
      else {
        expand.set(
          withTiming(0, { duration: motion.base, easing: Easing.out(Easing.cubic) }),
        );
      }
    },
  });

  const collapsePan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-20, 20])
        .failOffsetX([-40, 40])
        .onUpdate((event) => {
          if (lyricsMode === 'over') {
            // One drag does both: peel the lyrics away to the cover, then keep
            // shrinking the full player into the dock.
            const dy = Math.max(0, event.translationY);
            const reveal = Math.min(1, dy / LYRICS_REVEAL_DISTANCE);
            coverOpacity.value = reveal;
            lyricsOpacity.value = 1 - reveal;
            const shrink = Math.max(0, dy - LYRICS_REVEAL_DISTANCE);
            expand.value = Math.max(0, 1 - shrink / (height * 0.4));
            return;
          }
          if (event.translationY <= 0) return;
          expand.value = Math.max(0, 1 - event.translationY / (height * 0.4));
        })
        .onEnd((event) => {
          if (lyricsMode === 'over') {
            if (event.translationY > 90 || event.velocityY > 700) scheduleOnRN(collapse);
            else {
              coverOpacity.value = withTiming(0, { duration: motion.base });
              lyricsOpacity.value = withTiming(1, { duration: motion.base });
              expand.value = withSpring(1, motion.spring.smooth);
            }
            return;
          }
          if (event.translationY > 110 || event.velocityY > 900) scheduleOnRN(collapse);
          else expand.value = withSpring(1, motion.spring.smooth);
        }),
    [collapse, coverOpacity, expand, height, lyricsMode, lyricsOpacity],
  );

  const seed = track ? `${track.artist}${track.album ?? ''}` : '';
  const hasLyrics = Boolean(lyrics);

  return (
    <View
      style={styles.surface}
      pointerEvents={expanded ? 'auto' : 'box-none'}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, bgStyle]}>
        <AmbientBackground seed={seed} artwork={track?.artwork} />
      </Animated.View>

      <GestureDetector gesture={collapsePan}>
        <Animated.View
          pointerEvents={expanded ? 'auto' : 'none'}
          style={[styles.full, { paddingTop: insets.top }, fullStyle]}
        >
          <View style={styles.topBar}>
            <Touch
              style={styles.iconButton}
              glass
              onPress={collapse}
              accessibilityLabel="Close player"
            >
              <Ionicons name="chevron-down" size={24} color={palette.text} />
            </Touch>
            <View style={styles.topText}>
              <Text style={styles.topLabel}>NOW PLAYING</Text>
              <Text style={styles.topValue} numberOfLines={1}>
                {track?.album ?? 'On this device'}
              </Text>
            </View>
            <Touch
              style={styles.iconButton}
              glass
              onPress={() => router.push('/queue')}
              accessibilityLabel="Open queue"
            >
              <Ionicons name="list" size={22} color={palette.text} />
            </Touch>
          </View>

        <View style={styles.stage} onLayout={onStageLayout} />

        <Animated.View key={track?.id} entering={FadeIn.duration(240)} style={styles.meta}>
          <Touch
            style={styles.metaText}
            haptic="none"
            onPress={() => {
              if (!track) return;
              router.push({ pathname: '/track/[id]', params: { id: track.id } });
            }}
            accessibilityLabel="Open track details"
          >
            <Text style={styles.title} numberOfLines={1}>
              {track?.title ?? ''}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {track?.artist ?? ''}
              {track?.album ? ` · ${track.album}` : ''}
            </Text>
          </Touch>
<Ionicons name="chevron-forward" size={18} color={palette.textFaint} />
        </Animated.View>

        <PlayerProgress simultaneousHandlers={collapsePan} />

        <View style={[styles.controls, { paddingBottom: insets.bottom + 24 }]}>
          <Touch
            style={styles.sideControl}
            onPress={toggleShuffle}
            accessibilityLabel="Toggle shuffle"
          >
            <Ionicons
              name="shuffle"
              size={20}
              color={shuffle ? palette.accent : palette.textFaint}
            />
          </Touch>
          <Touch
            style={styles.sideControl}
            onPress={previous}
            accessibilityLabel="Previous track"
          >
            <Ionicons name="play-skip-back" size={30} color={palette.text} />
          </Touch>

          <Touch
            style={styles.playButton}
            onPress={toggle}
            haptic="medium"
            accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
          >
            <Ionicons
              name={isPlaying ? 'pause' : 'play'}
              size={34}
              color={palette.bgElevated}
              style={isPlaying ? undefined : styles.playGlyph}
            />
          </Touch>

          <Touch style={styles.sideControl} onPress={next} accessibilityLabel="Next track">
            <Ionicons name="play-skip-forward" size={30} color={palette.text} />
          </Touch>
          <Touch
            style={styles.sideControl}
            onPress={toggleRepeat}
            accessibilityLabel="Toggle repeat"
          >
            <MaterialIcons
              name={repeat === 'one' ? 'repeat-one' : 'repeat'}
              size={22}
              color={repeat !== 'off' ? palette.accent : palette.textFaint}
            />
          </Touch>
        </View>
        </Animated.View>
      </GestureDetector>

      <Animated.View
        style={[styles.mini, { bottom }, miniStyle]}
        pointerEvents={!track || expanded ? 'none' : 'box-none'}
      >
        <GestureDetector gesture={miniPan}>
          <View style={styles.miniViewport}>
            <FlatList
              ref={carouselRef}
              data={queue}
              horizontal
              pagingEnabled
              bounces={false}
              overScrollMode="never"
              showsHorizontalScrollIndicator={false}
              decelerationRate="fast"
              scrollEnabled={queue.length > 1}
              removeClippedSubviews={false}
              style={styles.miniCarousel}
              keyExtractor={(item, index) => `${item.id}-${index}`}
              getItemLayout={(_, index) => ({
                length: width,
                offset: width * index,
                index,
              })}
              initialScrollIndex={
                queue.length > 0 ? Math.max(0, Math.min(queueIndex, queue.length - 1)) : undefined
              }
              extraData={`${queueIndex}:${track?.id ?? ''}:${isPlaying}`}
              initialNumToRender={3}
              maxToRenderPerBatch={3}
              windowSize={3}
              onMomentumScrollEnd={onCarouselEnd}
              renderItem={({ item, index }) => {
                const active = index === queueIndex && item.id === track?.id;
                return (
                  <View style={[styles.miniPage, { width }]}>
                    <Animated.View style={miniArtStyle}>
                      <Artwork uri={item.artwork} size={MINI_ART} borderRadius={radius.sm} />
                    </Animated.View>
                    <Touch
                      style={styles.miniText}
                      onPress={() => selectPage(index)}
                      accessibilityLabel="Open player"
                    >
                      <Text numberOfLines={1} style={styles.miniTitle}>
                        {item.title}
                      </Text>
                      <Text numberOfLines={1} style={styles.miniArtist}>
                        {item.artist}
                      </Text>
                    </Touch>
                    <View style={styles.miniActions}>
                      <EqBars active={active && isPlaying} color={palette.accentAlt} height={16} />
                      <Touch
                        style={styles.miniAction}
                        onPress={() => togglePage(index)}
                        accessibilityLabel={active && isPlaying ? 'Pause' : 'Play'}
                      >
                        <Ionicons
                          name={active && isPlaying ? 'pause' : 'play'}
                          size={24}
                          color={palette.text}
                          style={!active || !isPlaying ? styles.playIcon : undefined}
                        />
                      </Touch>
                    </View>
                  </View>
                );
              }}
            />
          </View>
        </GestureDetector>
        <MiniProgress />
      </Animated.View>

      <GestureDetector gesture={artPan}>
        <Animated.View
          pointerEvents={expanded ? 'auto' : 'none'}
          style={[
            styles.artBox,
            { left: stage.x, top: stage.y, width: stage.size, height: stage.size },
            artStyle,
          ]}
        >
          {track ? (
            <>
              <Animated.View
                key={track.id}
                entering={FadeIn.duration(240)}
                style={[styles.fill, coverStyle]}
              >
                <Artwork uri={track.artwork} size={stage.size} borderRadius={radius.lg} />
              </Animated.View>
              {expanded && hasLyrics && lyricsMode === 'off' ? (
                <LyricsToggle shown={false} onPress={() => setLyricsMode('over')} />
              ) : null}
            </>
          ) : null}
        </Animated.View>
      </GestureDetector>

      {expanded && lyricsMode === 'over' ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(140)}
          style={[styles.lyricsPanel, { top: stage.top, height: stage.height }, lyricsStyle]}
        >
          <LyricsView lyrics={lyrics} onSeek={seek} />
          <LyricsToggle shown onPress={() => setLyricsMode('off')} />
        </Animated.View>
      ) : null}
    </View>
  );
}

function LyricsToggle({ shown, onPress }: { shown: boolean; onPress: () => void }) {
  return (
    <Touch
      style={[styles.lyricsPill, shown && styles.lyricsPillOn]}
      glass={!shown}
      onPress={onPress}
      accessibilityLabel={shown ? 'Hide lyrics' : 'Show lyrics'}
    >
      <Text style={[styles.lyricsPillText, shown && styles.lyricsPillTextOn]}>
        {shown ? 'Hide' : 'Lyrics'}
      </Text>
    </Touch>
  );
}

/** Isolated so the 4 Hz position updates only touch the scrubber. */
function PlayerProgress({
  simultaneousHandlers,
}: {
  simultaneousHandlers?: ProgressBarProps['simultaneousHandlers'];
}) {
  const position = usePlayerStore((state) => state.position);
  const duration = usePlayerStore((state) => state.duration);
  const seek = usePlayerStore((state) => state.seek);

  return (
    <View style={styles.progress}>
      <ProgressBar position={position} duration={duration} onSeek={seek} color={palette.accent} simultaneousHandlers={simultaneousHandlers} showWaveform height={6} />
      <View style={styles.times}>
        <Text style={styles.time}>{formatDuration(position)}</Text>
        <Text style={styles.time}>-{formatDuration(Math.max(0, duration - position))}</Text>
      </View>
    </View>
  );
}

/** Isolated so the 4 Hz position updates do not re-render the whole bar. */
function MiniProgress() {
  const position = usePlayerStore((state) => state.position);
  const duration = usePlayerStore((state) => state.duration);

  return (
    <View style={styles.miniProgress} pointerEvents="none">
      <ProgressBar
        position={position}
        duration={duration}
        color={palette.accentAlt}
        trackColor={palette.borderHi}
        height={2}
        align="top"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Elevated so it draws over the tab screens on Android: an elevated button
   * in a sibling subtree would otherwise paint on top of the player.
   */
  surface: {
    ...absoluteFill,
    elevation: 40,
    zIndex: 40,
  },
  full: {
    ...absoluteFill,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
  },
  topText: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  topLabel: {
    ...font.caption,
    color: palette.textFaint,
  },
  topValue: {
    ...font.label,
    color: palette.text,
  },
  iconButton: {
    width: HIT.min,
    height: HIT.min,
    borderRadius: HIT.min / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stage: {
    flex: 1,
    minHeight: 0,
  },
  artBox: {
    position: 'absolute',
    overflow: 'hidden',
  },
  fill: {
    ...absoluteFill,
  },


  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 24,
    paddingTop: 18,
  },
  metaText: {
    flex: 1,
    gap: 4,
  },
  title: {
    ...font.title,
    color: palette.text,
  },
  artist: {
    ...font.body,
    fontWeight: '500',
    color: palette.textDim,
  },
  progress: {
    paddingHorizontal: 24,
    paddingTop: 6,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -2,
  },
  time: {
    ...font.caption,
    color: palette.textFaint,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 10,
  },
  sideControl: {
    width: HIT.min,
    height: HIT.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButton: {
    width: HIT.primary,
    height: HIT.primary,
    borderRadius: HIT.primary / 2,
    backgroundColor: palette.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: {
    marginLeft: 4,
  },
  lyricsPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  lyricsPill: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    height: 36,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lyricsPillOn: {
    backgroundColor: palette.text,
  },
  lyricsPillText: {
    ...font.label,
    color: palette.text,
  },
  lyricsPillTextOn: {
    color: palette.bgElevated,
  },
  mini: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: PLAYER_BAR_HEIGHT,
    backgroundColor: palette.surface,
  },
  miniViewport: {
    flex: 1,
    height: PLAYER_BAR_HEIGHT,
    overflow: 'hidden',
  },
  miniCarousel: {
    flex: 1,
  },
  miniPage: {
    flexDirection: 'row',
    alignItems: 'center',
    height: PLAYER_BAR_HEIGHT,
    paddingHorizontal: MINI_PAD,
    gap: 8,
  },
  miniText: {
    flex: 1,
    height: PLAYER_BAR_HEIGHT,
    justifyContent: 'center',
    gap: 1,
  },
  miniTitle: {
    ...font.label,
    fontSize: 14,
    color: palette.text,
  },
  miniArtist: {
    ...font.caption,
    letterSpacing: 0,
    fontWeight: '500',
    color: palette.textDim,
  },
  miniActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  miniAction: {
    width: HIT.comfortable,
    height: HIT.comfortable,
    borderRadius: HIT.comfortable / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    marginLeft: 3,
  },
  miniProgress: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 4,
  },
});
