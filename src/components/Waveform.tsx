import { memo, useMemo } from 'react';
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

interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

function drawBars(bars: readonly Bar[], fill: string, prefix: string) {
  return bars.map((bar, index) => (
    <Rect
      key={`${prefix}-${index}`}
      x={bar.x}
      y={bar.y}
      width={bar.width}
      height={bar.height}
      rx={bar.radius}
      fill={fill}
    />
  ));
}

/**
 * Waveform drawn from peak data.
 *
 * Two stacked copies of the same bars — dim for the whole track, bright inside
 * a clipped, animated-width View for the played part. The bright layer is
 * clipped on the UI thread, so scrubbing never re-renders the bars.
 *
 * The bars are built once per peak set and per colour, and the whole component
 * is memoised: the scrubber re-renders on every engine tick, and rebuilding up
 * to 240 `Rect` elements twice over, four times a second, was pure waste.
 */
export const Waveform = memo(function Waveform({
  peaks,
  width,
  height,
  color,
  trackColor,
  progressStyle,
}: WaveformProps) {
  const columns = columnsForWidth(width);
  const data = useMemo(() => resamplePeaks(peaks, columns), [peaks, columns]);

  const bars = useMemo(() => {
    const slot = width / Math.max(1, data.length);
    const barWidth = Math.max(1, slot * 0.62);
    const radius = Math.min(barWidth / 2, 1.5);
    return data.map((peak, index) => {
      const barHeight = Math.max(1.5, Math.min(1, peak) * height);
      return {
        x: index * slot + (slot - barWidth) / 2,
        y: (height - barHeight) / 2,
        width: barWidth,
        height: barHeight,
        radius,
      };
    });
  }, [data, width, height]);

  const dimBars = useMemo(() => drawBars(bars, trackColor, 'dim'), [bars, trackColor]);
  const litBars = useMemo(() => drawBars(bars, color, 'lit'), [bars, color]);

  return (
    <View style={{ width, height }} pointerEvents="none">
      <Svg width={width} height={height}>
        {dimBars}
      </Svg>
      <Animated.View style={[styles.reveal, progressStyle]}>
        <Svg width={width} height={height}>
          {litBars}
        </Svg>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  reveal: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    overflow: 'hidden',
  },
});
