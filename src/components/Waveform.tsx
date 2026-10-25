import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { type useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';

import { columnsForWidth, resamplePeaks } from '../lib/waveform';

export interface WaveformProps {
  /** Stored peaks; resampled to the available width before drawing. */
  peaks: number[];
  width: number;
  height: number;
  /** Colour of the played part. */
  color: string;
  /** Colour of the part still ahead. */
  trackColor: string;
  /** Animated width percentage for the played overlay. */
  progressStyle: ReturnType<typeof useAnimatedStyle>;
}

/**
 * Waveform drawn from peak data.
 *
 * Two stacked copies of the same bars — dim for the whole track, bright inside
 * a clipped, animated-width View for the played part. The bright layer is
 * clipped on the UI thread, so scrubbing never re-renders the bars.
 */
export function Waveform({
  peaks,
  width,
  height,
  color,
  trackColor,
  progressStyle,
}: WaveformProps) {
  const columns = columnsForWidth(width);
  const data = useMemo(() => resamplePeaks(peaks, columns), [peaks, columns]);
  const slot = width / Math.max(1, data.length);
  const barWidth = Math.max(1, slot * 0.62);
  const radius = Math.min(barWidth / 2, 1.5);

  const bars = (fill: string) =>
    data.map((peak, index) => {
      const barHeight = Math.max(1.5, Math.min(1, peak) * height);
      return (
        <Rect
          key={`${fill}-${index}`}
          x={index * slot + (slot - barWidth) / 2}
          y={(height - barHeight) / 2}
          width={barWidth}
          height={barHeight}
          rx={radius}
          fill={fill}
        />
      );
    });

  return (
    <View style={{ width, height }} pointerEvents="none">
      <Svg width={width} height={height}>
        {bars(trackColor)}
      </Svg>
      <Animated.View style={[styles.reveal, progressStyle]}>
        <Svg width={width} height={height}>
          {bars(color)}
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  reveal: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    overflow: 'hidden',
  },
});
