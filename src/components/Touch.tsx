import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { useCallback, useRef } from 'react';
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { motion, palette } from '../theme';

type Haptic = 'light' | 'medium' | 'none';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface TouchProps {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
  haptic?: Haptic;
  disabled?: boolean;
  accessibilityLabel?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Adds a glass surface whose highlight leans toward the finger while held. */
  glass?: boolean;
}

/**
 * Every tappable thing in the app goes through here: a springy press-scale
 * plus a light haptic. Scale only, no layout animation, so it stays cheap.
 *
 * The pressable *is* the styled element, so callers lay children out on it
 * directly instead of nesting an extra absolutely positioned layer.
 *
 * On a glass surface the specular highlight follows the touch: pressing the top
 * left pushes the light up and left, letting go springs it back to rest. It is
 * one translate derived from the press point, so the material gains weight
 * without any extra layout or a line drawn across the top.
 */
export function Touch({
  children,
  onPress,
  onLongPress,
  style,
  haptic = 'light',
  disabled,
  accessibilityLabel,
  onLayout,
  glass,
}: TouchProps) {
  const pressed = useSharedValue(0);
  /** Press point, normalised to -1..1 on each axis. */
  const leanX = useSharedValue(0);
  const leanY = useSharedValue(0);
  const size = useRef({ width: 0, height: 0 });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.055 }],
    opacity: 1 - pressed.value * 0.12,
  }));

  const sheenStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + pressed.value * 0.5,
    transform: [
      { translateX: leanX.value * 6 },
      { translateY: leanY.value * 4 },
      // Slightly larger than the surface so the lean never exposes an edge.
      { scale: 1.06 + pressed.value * 0.02 },
    ],
  }));

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (haptic !== 'none') {
      void Haptics.impactAsync(
        haptic === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
      );
    }
    onPress?.();
  }, [disabled, haptic, onPress]);

  const trackPress = (event: GestureResponderEvent) => {
    if (!glass) return;
    const { width, height } = size.current;
    if (width <= 0 || height <= 0) return;
    const { locationX, locationY } = event.nativeEvent;
    leanX.value = withSpring((locationX / width - 0.5) * 2, motion.spring.smooth);
    leanY.value = withSpring((locationY / height - 0.5) * 2, motion.spring.smooth);
  };

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={handlePress}
      onLongPress={onLongPress}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        size.current = { width, height };
        onLayout?.(event);
      }}
      onPressIn={(event) => {
        pressed.value = withSpring(1, motion.spring.snappy);
        trackPress(event);
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, motion.spring.snappy);
        if (!glass) return;
        leanX.value = withSpring(0, motion.spring.smooth);
        leanY.value = withSpring(0, motion.spring.smooth);
      }}
      style={[animatedStyle, style, glass && styles.glass]}
    >
      {children}
      {glass ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, sheenStyle]}>
          <LinearGradient
            colors={[
              'rgba(255,255,255,0.14)',
              'rgba(255,255,255,0.04)',
              'rgba(154,242,255,0.07)',
              'rgba(4,6,12,0.10)',
            ]}
            locations={[0, 0.32, 0.7, 1]}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  glass: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.glassEdge,
    backgroundColor: palette.glass,
  },
});
