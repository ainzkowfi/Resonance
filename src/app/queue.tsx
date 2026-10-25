import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Artwork } from '../components/Artwork';
import { PreparingChip } from '../components/PreparingChip';
import { ScreenHeader } from '../components/ScreenHeader';
import { Touch } from '../components/Touch';
import { formatDuration } from '../lib/format';
import { usePlayerStore } from '../store/player';
import { font, HIT, motion, palette, radius } from '../theme';

const ROW_HEIGHT = 68;

export default function QueueScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queue = usePlayerStore((state) => state.queue);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const playTracks = usePlayerStore((state) => state.playTracks);
  const removeAt = usePlayerStore((state) => state.removeAt);
  const moveInQueue = usePlayerStore((state) => state.moveInQueue);
  const clearQueue = usePlayerStore((state) => state.clearQueue);

  const [draggingId, setDraggingId] = useState<string | null>(null);

  const totalSeconds = useMemo(
    () => queue.reduce((sum, track) => sum + (track.duration || 0), 0),
    [queue],
  );

  const move = (from: number, to: number) => {
    moveInQueue(from, to);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Queue"
        subtitle={`${queue.length} tracks · ${formatDuration(totalSeconds)}`}
        back
        action={
          queue.length > 0
            ? {
                icon: 'trash-outline',
                label: 'Clear queue',
                onPress: () => {
                  clearQueue();
                  router.back();
                },
              }
            : undefined
        }
      />

      {queue.length === 0 ? (
        <Animated.View entering={FadeIn.duration(220)} style={styles.empty}>
          <Text style={styles.emptyTitle}>The queue is empty</Text>
          <Text style={styles.emptyBody}>Play something from your library or search.</Text>
        </Animated.View>
      ) : (
        <FlatList
          data={queue}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          renderItem={({ item, index }) => (
            <QueueRow
              track={item}
              index={index}
              count={queue.length}
              current={item.id === currentTrack?.id}
              active={item.id === draggingId}
              onPress={() => {
                playTracks(queue, index);
                router.back();
              }}
              onRemove={() => removeAt(index)}
              onMove={(to) => move(index, to)}
              onDragState={setDraggingId}
            />
          )}
        />
      )}
    </View>
  );
}

function QueueRow({
  track,
  index,
  count,
  current,
  active,
  onPress,
  onRemove,
  onMove,
  onDragState,
}: {
  track: { id: string; title: string; artist: string; artwork?: string; duration: number };
  index: number;
  count: number;
  current: boolean;
  active: boolean;
  onPress: () => void;
  onRemove: () => void;
  onMove: (to: number) => void;
  onDragState: (id: string | null) => void;
}) {
  const preparing = usePlayerStore((state) => state.preparingId === track.id);
  const translateY = useSharedValue(0);
  const dragging = useSharedValue(false);

  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(180)
        .onStart(() => {
          dragging.value = true;
          runOnJS(onDragState)(track.id);
        })
        .onUpdate((event) => {
          translateY.value = event.translationY;
        })
        .onEnd((event) => {
          const delta = Math.round(event.translationY / ROW_HEIGHT);
          translateY.value = withSpring(0, motion.spring.snappy);
          dragging.value = false;
          runOnJS(onDragState)(null);
          if (delta !== 0) {
            const target = Math.max(0, Math.min(count - 1, index + delta));
            if (target !== index) runOnJS(onMove)(target);
          }
        }),
    [count, index, onDragState, onMove, track.id, translateY, dragging],
  );

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: dragging.value ? 1.03 : 1 }],
    zIndex: dragging.value ? 10 : 0,
  }));

  return (
    <GestureDetector gesture={dragGesture}>
      <Animated.View style={[styles.row, current && styles.rowCurrent, rowStyle]}>
        <Touch style={styles.rowMain} onPress={onPress} haptic="none">
          <View style={styles.handle}>
            <Ionicons name="reorder-three" size={20} color={palette.textFaint} />
          </View>
          <Artwork uri={track.artwork} size={44} borderRadius={radius.sm} />
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, current && styles.rowTitleCurrent]} numberOfLines={1}>
              {track.title}
            </Text>
            <Text style={styles.rowSubtitle} numberOfLines={1}>
              {track.artist}
            </Text>
          </View>
          {preparing ? (
            <PreparingChip />
          ) : (
            <Text style={styles.rowDuration}>{formatDuration(track.duration)}</Text>
          )}
        </Touch>
        <Touch
          style={styles.remove}
          onPress={onRemove}
          accessibilityLabel={`Remove ${track.title} from queue`}
        >
          <Ionicons name="close" size={18} color={palette.textFaint} />
        </Touch>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  listContent: {
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    paddingRight: 12,
    backgroundColor: palette.bg,
  },
  rowCurrent: {
    backgroundColor: palette.selectionStrong,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 12,
    height: ROW_HEIGHT,
  },
  handle: {
    width: 22,
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    ...font.body,
    fontSize: 15,
    color: palette.text,
  },
  rowTitleCurrent: {
    color: palette.accent,
  },
  rowSubtitle: {
    ...font.label,
    fontWeight: '500',
    color: palette.textDim,
  },
  rowDuration: {
    ...font.label,
    color: palette.textFaint,
  },
  remove: {
    width: HIT.min,
    height: HIT.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    padding: 40,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: {
    ...font.title,
    color: palette.text,
  },
  emptyBody: {
    ...font.body,
    fontWeight: '500',
    color: palette.textFaint,
  },
});
