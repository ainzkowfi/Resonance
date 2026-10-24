import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { Gesture, GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
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
import { AmbientBackground } from './AmbientBackground';
import { Artwork } from './Artwork';
import { PLAYER_BAR_HEIGHT } from './bottomBar';
import { EqBars } from './EqBars';
import { LyricsView } from './LyricsView';
import { ProgressBar } from './ProgressBar';
import { Touch } from './Touch';

type LyricsMode = 'off' | 'over';

const absoluteFill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const MINI_ART = 44;
const MINI_PAD = 10;

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
  const pendingMiniEntry = useRef<number | null>(null);
  const reduceMotion = useReducedMotion();
  const lyrics = useTrackLyrics(track);

  const expand = useSharedValue(0);
  const dragX = useSharedValue(0);
  const shown = useSharedValue(0);
  const miniTrackX = useSharedValue(0);
  const miniTrackOpacity = useSharedValue(1);
  const miniGestureAxis = useSharedValue(0);

  useEffect(() => {
    expand.value = withSpring(expanded ? 1 : 0, motion.spring.smooth);
  }, [expanded, expand]);

  useEffect(() => {
    shown.value = withSpring(track ? 1 : 0, motion.spring.smooth);
  }, [track, shown]);

  useEffect(() => {
    const direction = pendingMiniEntry.current;
    if (direction === null) return;
    pendingMiniEntry.current = null;
    miniTrackX.set(reduceMotion ? 0 : -direction * Math.min(width * 0.22, 72));
    miniTrackOpacity.set(0);
    miniTrackX.set(withSpring(0, motion.spring.snappy));
    miniTrackOpacity.set(withTiming(1, { duration: motion.fast }));
  }, [miniTrackOpacity, miniTrackX, reduceMotion, track?.id, width]);

  const collapse = useCallback(() => {
    close();
    setLyricsMode('off');
  }, [close]);

  const skip = useCallback(
    (direction: number) => {
      if (direction < 0) next();
      else {
        const state = usePlayerStore.getState();
        // A mini-player swipe previews and selects the previous queue item;
        // keep the button's usual "restart after 3 seconds" behavior intact.
        if (state.queueIndex > 0 && state.position > 3) {
          usePlayerStore.setState({ position: 0 });
        }
        previous();
      }
    },
    [next, previous],
  );

  const skipFromMini = useCallback(
    (direction: number) => {
      const before = usePlayerStore.getState().currentTrack?.id;
      pendingMiniEntry.current = direction;
      skip(direction);
      const after = usePlayerStore.getState().currentTrack?.id;
      if (before === after) {
        pendingMiniEntry.current = null;
        miniTrackX.set(withSpring(0, motion.spring.snappy));
        miniTrackOpacity.set(withTiming(1, { duration: motion.fast }));
      }
    },
    [miniTrackOpacity, miniTrackX, skip],
  );

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
      opacity: (size > 0 ? 1 : 0) * miniTrackOpacity.get(),
      borderRadius: interpolate(e, [0, 1], [radius.sm / k, radius.lg]),
      transform: [
        {
          translateX:
            interpolate(e, [0, 1], [miniCx - (stage.x + size / 2), 0]) +
            dragX.get() +
            miniTrackX.get(),
        },
        {
          translateY: interpolate(e, [0, 1], [miniCy - (stage.y + size / 2), 0]),
        },
        { scale: interpolate(e, [0, 1], [k, 1]) },
      ],
    };
  }, [stage, miniCx, miniCy, dragX, miniTrackOpacity, miniTrackX]);

  const miniTrackStyle = useAnimatedStyle(() => ({
    opacity: miniTrackOpacity.get(),
    transform: [{ translateX: miniTrackX.get() }],
  }));

  const nextTrack =
    repeat === 'one'
      ? track
      : queueIndex < queue.length - 1
        ? queue[queueIndex + 1]
        : repeat === 'all' && queue.length > 1
          ? queue[0]
          : null;
  const previousTrack = queueIndex > 0 ? queue[queueIndex - 1] : track;
  const canSwipeNext = Boolean(nextTrack);
  const canSwipePrevious = Boolean(previousTrack);

  const nextPreviewStyle = useAnimatedStyle(() => {
    const x = miniTrackX.get();
    const progress = interpolate(
      -Math.min(0, x),
      [0, Math.max(1, width * 0.62)],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity: progress,
      transform: [{ translateX: width + Math.min(0, x) }],
    };
  }, [miniTrackX, width]);

  const previousPreviewStyle = useAnimatedStyle(() => {
    const x = miniTrackX.get();
    const progress = interpolate(
      Math.max(0, x),
      [0, Math.max(1, width * 0.62)],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity: progress,
      transform: [{ translateX: -width + Math.max(0, x) }],
    };
  }, [miniTrackX, width]);

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
            expand.value = Math.max(0, 1 - event.translationY / (height * 0.4));
          }
        })
        .onEnd((event) => {
          dragX.value = withSpring(0, motion.spring.snappy);
          if (Math.abs(event.translationX) > Math.abs(event.translationY)) {
            if (event.translationX < -70) scheduleOnRN(next);
            else if (event.translationX > 70) scheduleOnRN(previous);
          } else if (event.translationY > 110 || event.velocityY > 900) {
            scheduleOnRN(collapse);
          } else {
            expand.value = withSpring(1, motion.spring.smooth);
          }
        }),
    [collapse, dragX, expand, height, next, previous],
  );

  const miniPan = usePanGesture({
    activeOffsetY: [-14, 14],
    activeOffsetX: [-24, 24],
    onUpdate: (event) => {
      const absX = Math.abs(event.translationX);
      const absY = Math.abs(event.translationY);
      if (miniGestureAxis.get() === 0 && Math.max(absX, absY) > 12) {
        // Accept diagonal thumb swipes while keeping the intended axis stable
        // for the rest of the gesture.
        miniGestureAxis.set(absX >= absY * 0.65 ? 1 : -1);
      }
      if (miniGestureAxis.get() === 1) {
        // Keep the neighbor preview under the user's finger even when reduced
        // motion is enabled; only the release animation changes in that mode.
        miniTrackX.set(event.translationX);
        miniTrackOpacity.set(
          interpolate(
            Math.abs(event.translationX),
            [0, Math.max(1, width * 0.62)],
            [1, 0.24],
            Extrapolation.CLAMP,
          ),
        );
      } else if (miniGestureAxis.get() === -1) {
        miniTrackX.set(0);
        miniTrackOpacity.set(1);
        if (event.translationY < 0) {
          expand.set(Math.min(1, -event.translationY / (height * 0.4)));
        }
      }
    },
    onDeactivate: (event) => {
      if (event.canceled) {
        miniGestureAxis.set(0);
        miniTrackX.set(withSpring(0, motion.spring.snappy));
        miniTrackOpacity.set(withTiming(1, { duration: motion.fast }));
        return;
      }

      const horizontal = miniGestureAxis.get() === 1;
      miniGestureAxis.set(0);
      const shouldSkip =
        horizontal && (Math.abs(event.translationX) > 72 || Math.abs(event.velocityX) > 600);
      if (shouldSkip) {
        const swipeDirection =
          (Math.abs(event.translationX) > 72 ? event.translationX : event.velocityX) < 0 ? -1 : 1;
        const canSkip = swipeDirection < 0 ? canSwipeNext : canSwipePrevious;
        if (!canSkip) {
          miniTrackX.set(withSpring(0, { ...motion.spring.snappy, velocity: event.velocityX }));
          miniTrackOpacity.set(withTiming(1, { duration: motion.fast }));
          return;
        }
        if (reduceMotion) {
          miniTrackX.set(0);
          miniTrackOpacity.set(
            withTiming(0, { duration: motion.fast }, (finished) => {
              if (finished) scheduleOnRN(skipFromMini, swipeDirection);
            }),
          );
        } else {
          miniTrackOpacity.set(withTiming(0, { duration: motion.fast }));
          miniTrackX.set(
            withTiming(
              swipeDirection * width,
              { duration: 220 },
              (finished) => {
                if (finished) scheduleOnRN(skipFromMini, swipeDirection);
              },
            ),
          );
        }
        return;
}

      // Sub-threshold horizontal: snap back instantly without spring animation
      if (horizontal) {
        miniTrackX.set(0);
        miniTrackOpacity.set(1);
      } else {
        miniTrackX.set(withSpring(0, { ...motion.spring.snappy, velocity: event.velocityX }));
        miniTrackOpacity.set(withTiming(1, { duration: motion.fast }));
      }
      const shouldOpen = !horizontal && (expand.get() > 0.3 || event.velocityY < -600);
      if (shouldOpen) scheduleOnRN(open);
      else expand.set(withSpring(0, motion.spring.smooth));
    },
  });

  const collapsePan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-20, 20])
        .failOffsetX([-40, 40])
        .onUpdate((event) => {
          if (event.translationY > 0) {
            expand.value = Math.max(0, 1 - event.translationY / (height * 0.4));
          }
        })
        .onEnd((event) => {
          if (event.translationY > 110 || event.velocityY > 900) scheduleOnRN(collapse);
          else expand.value = withSpring(1, motion.spring.smooth);
        }),
    [collapse, expand, height],
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
        <View style={styles.miniGlass} pointerEvents="none" />
        <GestureDetector gesture={miniPan}>
          <View style={styles.miniViewport}>
            <Animated.View style={[styles.miniInner, miniTrackStyle]}>
              <View style={styles.miniArt} />
              <Touch style={styles.miniText} onPress={open} accessibilityLabel="Open player">
                <Text numberOfLines={1} style={styles.miniTitle}>
                  {track?.title ?? ''}
                </Text>
                <Text numberOfLines={1} style={styles.miniArtist}>
                  {track?.artist ?? ''}
                </Text>
              </Touch>
              <View style={styles.miniActions}>
                <EqBars active={Boolean(isPlaying)} color={palette.accentAlt} height={16} />
                <Touch
                  style={styles.miniAction}
                  onPress={toggle}
                  accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
                >
                  <Ionicons
                    name={isPlaying ? 'pause' : 'play'}
                    size={24}
                    color={palette.text}
                    style={!isPlaying ? styles.playIcon : undefined}
                  />
                </Touch>
              </View>
            </Animated.View>
            {nextTrack ? (
              <Animated.View
                pointerEvents="none"
                style={[styles.miniPreview, nextPreviewStyle]}
              >
                <View style={styles.miniPreviewArt}>
                  <Artwork uri={nextTrack.artwork} size={MINI_ART} borderRadius={radius.sm} />
                </View>
                <View style={styles.miniPreviewText}>
                  <Text style={styles.miniPreviewLabel}>UP NEXT</Text>
                  <Text numberOfLines={1} style={styles.miniTitle}>
                    {nextTrack.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.miniArtist}>
                    {nextTrack.artist}
                  </Text>
                </View>
                <Ionicons name="play-forward" size={18} color={palette.accent} />
              </Animated.View>
            ) : null}
            {previousTrack ? (
              <Animated.View
                pointerEvents="none"
                style={[styles.miniPreview, previousPreviewStyle]}
              >
                <View style={styles.miniPreviewArt}>
                  <Artwork uri={previousTrack.artwork} size={MINI_ART} borderRadius={radius.sm} />
                </View>
                <View style={styles.miniPreviewText}>
                  <Text style={styles.miniPreviewLabel}>
                    {queueIndex > 0 ? 'PREVIOUS' : 'RESTART'}
                  </Text>
                  <Text numberOfLines={1} style={styles.miniTitle}>
                    {previousTrack.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.miniArtist}>
                    {previousTrack.artist}
                  </Text>
                </View>
                <Ionicons name="play-back" size={18} color={palette.accent} />
              </Animated.View>
            ) : null}
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
                style={[styles.fill, lyricsMode === 'over' && styles.coverHidden]}
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
          style={[styles.lyricsPanel, { top: stage.top, height: stage.height }]}
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
function PlayerProgress({ simultaneousHandlers }: { simultaneousHandlers?: any }) {
  const position = usePlayerStore((state) => state.position);
  const duration = usePlayerStore((state) => state.duration);
  const seek = usePlayerStore((state) => state.seek);

  return (
    <View style={styles.progress}>
      <ProgressBar position={position} duration={duration} onSeek={seek} color={palette.accent} simultaneousHandlers={simultaneousHandlers} />
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
    <View style={styles.miniProgress}>
      <ProgressBar
        position={position}
        duration={duration}
        color={palette.accentAlt}
        trackColor={palette.borderHi}
        height={2}
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
    elevation: 24,
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
    backgroundColor: palette.glass,
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
  coverHidden: {
    opacity: 0,
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
    backgroundColor: palette.glass,
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
  },
  miniGlass: {
    ...absoluteFill,
    backgroundColor: palette.surface,
  },
  miniViewport: {
    flex: 1,
    height: PLAYER_BAR_HEIGHT,
    overflow: 'hidden',
  },
  miniInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: MINI_PAD,
    gap: 8,
  },
  miniPreview: {
    ...absoluteFill,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: MINI_PAD,
    gap: 8,
    backgroundColor: palette.bgElevated,
  },
  miniPreviewArt: {
    width: MINI_ART,
    height: MINI_ART,
  },
  miniPreviewText: {
    flex: 1,
    height: PLAYER_BAR_HEIGHT,
    justifyContent: 'center',
    gap: 1,
  },
  miniPreviewLabel: {
    ...font.caption,
    fontSize: 9,
    letterSpacing: 1.1,
    fontWeight: '700',
    color: palette.accent,
  },
  miniArt: {
    width: MINI_ART,
    height: MINI_ART,
  },
  miniText: {
    flex: 1,
    height: PLAYER_BAR_HEIGHT,
    justifyContent: 'center',
    gap: 2,
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
