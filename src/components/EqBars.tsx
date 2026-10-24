import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

const DURATIONS = [420, 300, 520];

interface EqBarsProps {
  active: boolean;
  color: string;
  height?: number;
}

/** Tiny animated equaliser, used in the mini player. */
export function EqBars({ active, color, height = 16 }: EqBarsProps) {
  return (
    <View style={[styles.row, { height }]}>
      {[0, 1, 2].map((index) => (
        <EqBar key={index} index={index} active={active} color={color} height={height} />
      ))}
    </View>
  );
}

function EqBar({
  index,
  active,
  color,
  height,
}: {
  index: number;
  active: boolean;
  color: string;
  height: number;
}) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (!active) {
      pulse.value = withTiming(0, { duration: 180 });
      return;
    }
    pulse.value = 0;
    pulse.value = withRepeat(
      withTiming(1, { duration: DURATIONS[index], easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [active, index, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: 3 + pulse.value * (height - 3),
  }));

  return <Animated.View style={[styles.bar, { backgroundColor: color }, animatedStyle]} />;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
  },
  bar: {
    width: 3,
    borderRadius: 2,
  },
});
