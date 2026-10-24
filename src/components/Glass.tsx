import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { palette } from '../theme';

const HAS_GLASS = Platform.OS === 'ios' && isLiquidGlassAvailable();

const BLUR_METHOD = Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none';

export interface GlassProps extends ViewProps {
  /** Corner radius of the sheet, so the blur is clipped to the shape. */
  radius?: number;
  intensity?: number;
}

function Refraction() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient
        colors={[
          palette.glassHighlight,
          'rgba(255,255,255,0.045)',
          'rgba(154,242,255,0.07)',
          'rgba(4,6,12,0.16)',
        ]}
        locations={[0, 0.34, 0.72, 1]}
        start={{ x: 0.12, y: 0 }}
        end={{ x: 0.88, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['transparent', 'rgba(255,255,255,0.46)', 'transparent']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.topEdge}
      />
      <LinearGradient
        colors={['transparent', 'rgba(154,242,255,0.24)', 'transparent']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={styles.bottomEdge}
      />
    </View>
  );
}

/**
 * Frosted surface. Real Liquid Glass on iOS 26, a blurred translucent layer
 * everywhere else. The gradient rim and specular edges make the material read
 * as glass even on devices where native refraction is unavailable.
 */
export function Glass({ children, style, radius, intensity = 68, ...rest }: GlassProps) {
  const clip = radius != null ? { borderRadius: radius } : null;

  if (HAS_GLASS) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        tintColor={palette.glass}
        style={[styles.clip, styles.frame, clip, style]}
        {...rest}
      >
        <Refraction />
        {children}
      </GlassView>
    );
  }

  return (
    <View style={[styles.clip, styles.frame, clip, style]} {...rest}>
      <BlurView
        intensity={intensity}
        tint="dark"
        blurMethod={BLUR_METHOD}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.tint, clip]} />
      <Refraction />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.glassBorder,
  },
  tint: {
    backgroundColor: palette.glass,
  },
  topEdge: {
    position: 'absolute',
    top: 1,
    left: 14,
    right: 14,
    height: 1,
  },
  bottomEdge: {
    position: 'absolute',
    bottom: 1,
    left: 20,
    right: 20,
    height: 1,
  },
});
