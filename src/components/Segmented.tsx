import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { font, motion, palette, radius, shadow } from '../theme';
import { Touch } from './Touch';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Pill that slides under the active segment. */
export function Segmented<T extends string>({ options, value, onChange }: SegmentedProps<T>) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const offset = useSharedValue(0);
  const size = useSharedValue(0);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const before = options
    .slice(0, index)
    .reduce((sum, option) => sum + (widths[option.value] ?? 0), 0);
  const active = widths[options[index]?.value] ?? 0;
  const ready = active > 0 && (index === 0 || before > 0);

  useEffect(() => {
    if (!ready) return;
    offset.value = withSpring(before + 6, motion.spring.snappy);
    size.value = withSpring(active - 6, motion.spring.snappy);
  }, [active, before, offset, ready, size]);

  const indicatorStyle = useAnimatedStyle(() => ({
    width: size.value,
    transform: [{ translateX: offset.value }],
  }));

  return (
    <View style={styles.root}>
      {ready ? <Animated.View style={[styles.indicator, indicatorStyle]} /> : null}
      {options.map((option) => (
        <Touch
          key={option.value}
          style={styles.segment}
          onPress={() => onChange(option.value)}
          haptic="none"
          accessibilityLabel={option.label}
          onLayout={(event) => {
            const next = event.nativeEvent.layout.width;
            if (next <= 0) return;
            setWidths((prev) =>
              prev[option.value] === next ? prev : { ...prev, [option.value]: next },
            );
          }}
        >
          <Text
            style={[styles.label, option.value === value ? styles.labelActive : styles.labelIdle]}
          >
            {option.label}
          </Text>
        </Touch>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    backgroundColor: palette.surfaceHi,
    borderRadius: radius.pill,
    padding: 3,
    alignSelf: 'flex-start',
  },
  segment: {
    paddingHorizontal: 12,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicator: {
    position: 'absolute',
    top: 3,
    left: 0,
    bottom: 3,
    borderRadius: radius.pill,
    backgroundColor: palette.bgElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.glassBorder,
    ...shadow.card,
  },
  label: {
    ...font.label,
  },
  labelActive: {
    color: palette.text,
  },
  labelIdle: {
    color: palette.textDim,
  },
});
