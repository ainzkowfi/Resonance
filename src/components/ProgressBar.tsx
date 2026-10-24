import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { motion, palette } from '../theme';

export interface ProgressBarProps {
  /** Seconds. */
  position: number;
  /** Seconds. */
  duration: number;
  onSeek?: (seconds: number) => void;
  color?: string;
  trackColor?: string;
  height?: number;
}

/**
 * Scrubber with a draggable thumb.
 *
 * Position and duration are mirrored into shared values so the pan gesture can
 * be created once and never stale.
 */
export function ProgressBar({
  position,
  duration,
  onSeek,
  color = palette.text,
  trackColor = palette.borderHi,
  height = 4,
}: ProgressBarProps) {
  const width = useSharedValue(0);
  const positionValue = useSharedValue(0);
  const durationValue = useSharedValue(0);
  const dragging = useSharedValue(false);
  const dragAmount = useSharedValue(0);
  const dragValue = useSharedValue(0);
  const onSeekRef = useRef<((seconds: number) => void) | undefined>(onSeek);
  onSeekRef.current = onSeek;

  useEffect(() => {
    // The engine ticks every 250 ms; gliding each tick keeps the line moving.
    positionValue.value = withTiming(position, { duration: 260, easing: Easing.linear });
  }, [position, positionValue]);

  useEffect(() => {
    durationValue.value = duration;
  }, [duration, durationValue]);

  const gesture = Gesture.Pan()
    .enabled(onSeek != null)
    .minDistance(0)
    .onBegin((event) => {
      dragging.value = true;
      dragAmount.value = withTiming(1, { duration: motion.fast });
      dragValue.value = width.value > 0 ? Math.min(1, Math.max(0, event.x / width.value)) : 0;
    })
    .onUpdate((event) => {
      if (width.value <= 0) return;
      dragValue.value = Math.min(1, Math.max(0, event.x / width.value));
    })
    .onEnd(() => {
      dragging.value = false;
      dragAmount.value = withTiming(0, { duration: motion.fast });
      const target = dragValue.value * durationValue.value;
      dragValue.value = 0;
      const seek = onSeekRef.current;
      if (seek) runOnJS(seek)(target);
    });

  const ratio = useAnimatedStyle(() => {
    const live = durationValue.value > 0 ? positionValue.value / durationValue.value : 0;
    const value = dragging.value ? dragValue.value : live;
    return { width: `${Math.min(100, Math.max(0, value * 100))}%` };
  });

  const thumbStyle = useAnimatedStyle(() => ({
    opacity: dragAmount.value,
    transform: [{ scale: 0.8 + dragAmount.value * 0.55 }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={styles.hitArea}
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width;
        }}
      >
        <View style={[styles.track, { height, borderRadius: height / 2, backgroundColor: trackColor }]}>
          <Animated.View
            style={[styles.fill, { height, borderRadius: height / 2, backgroundColor: color }, ratio]}
          >
            <Animated.View style={[styles.thumb, { backgroundColor: color }, thumbStyle]} />
          </Animated.View>
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hitArea: {
    height: 28,
    justifyContent: 'center',
  },
  track: {
    width: '100%',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  thumb: {
    position: 'absolute',
    right: -7,
    top: -5,
    width: 14,
    height: 14,
    borderRadius: 7,
  },
});
