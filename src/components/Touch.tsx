import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { type LayoutChangeEvent, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { motion } from '../theme';

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
}

/**
 * Every tappable thing in the app goes through here: a springy press-scale
 * plus a light haptic. Scale only, no layout animation, so it stays cheap.
 *
 * The pressable *is* the styled element, so callers lay children out on it
 * directly instead of nesting an extra absolutely positioned layer.
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
}: TouchProps) {
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.055 }],
    opacity: 1 - pressed.value * 0.12,
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

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={handlePress}
      onLongPress={onLongPress}
      onLayout={onLayout}
      onPressIn={() => {
        pressed.value = withSpring(1, motion.spring.snappy);
      }}
      onPressOut={() => {
        pressed.value = withSpring(0, motion.spring.snappy);
      }}
      style={[animatedStyle, style]}
    >
      {children}
    </AnimatedPressable>
  );
}
