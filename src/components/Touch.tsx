import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import {
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
  /** Adds a liquid-glass rim and a specular sweep that brightens while pressed. */
  glass?: boolean;
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
  glass,
}: TouchProps) {
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.055 }],
    opacity: 1 - pressed.value * 0.12,
  }));

  const sheenStyle = useAnimatedStyle(() => ({
    opacity: 0.46 + pressed.value * 0.5,
    transform: [{ translateX: pressed.value * 2 }],
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
      style={[animatedStyle, style, glass && styles.glass]}
    >
      {children}
      {glass ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, sheenStyle]}>
          <LinearGradient
            colors={[
              palette.glassHighlight,
              'rgba(255,255,255,0.035)',
              'rgba(154,242,255,0.08)',
              'rgba(255,255,255,0.015)',
            ]}
            locations={[0, 0.3, 0.62, 1]}
            start={{ x: 0.08, y: 0 }}
            end={{ x: 0.92, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={['transparent', 'rgba(255,255,255,0.42)', 'transparent']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={styles.rim}
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
    borderColor: palette.glassBorder,
    backgroundColor: palette.glass,
  },
  rim: {
    position: 'absolute',
    top: 1,
    left: '18%',
    right: '18%',
    height: 1,
  },
});
