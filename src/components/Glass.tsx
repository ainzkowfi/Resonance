import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { palette } from '../theme';

const HAS_GLASS = Platform.OS === 'ios' && isLiquidGlassAvailable();

const BLUR_METHOD = Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none';

export interface GlassProps extends ViewProps {
  /** Corner radius of the sheet, so the blur is clipped to the shape. */
  radius?: number;
  intensity?: number;
}

/**
 * Frosted surface. Real Liquid Glass on iOS 26, a blurred translucent layer
 * everywhere else — close enough to read as the same material.
 */
export function Glass({ children, style, radius, intensity = 50, ...rest }: GlassProps) {
  const clip = radius != null ? { borderRadius: radius } : null;

  if (HAS_GLASS) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        tintColor={palette.glass}
        style={[styles.clip, clip, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[styles.clip, clip, style]} {...rest}>
      <BlurView
        intensity={intensity}
        tint="dark"
        blurMethod={BLUR_METHOD}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.tint, clip]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  tint: {
    backgroundColor: palette.glass,
  },
});
