import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { motion, palette } from '../theme';

const HAS_GLASS = Platform.OS === 'ios' && isLiquidGlassAvailable();

const BLUR_METHOD = Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : 'none';

export interface GlassProps extends ViewProps {
  /** Corner radius of the sheet, so the blur is clipped to the shape. */
  radius?: number;
  intensity?: number;
  /** Freezes the highlight; use where several glass surfaces sit side by side. */
  still?: boolean;
}

/**
 * The material.
 *
 * Everything here is a soft gradient: a static one for the light coming from
 * above, plus a band that drifts across the surface once every few seconds. The
 * previous version drew two 1 px gradient rules — one along the top, one along
 * the bottom — which is what made every card and button look like it had a line
 * drawn on it. Refraction should be light, not an outline.
 */
function Sheen({ still }: { still: boolean }) {
  const reduced = useReducedMotion();
  const drift = useSharedValue(0.12);
  const width = useSharedValue(0);
  const height = useSharedValue(0);

  useEffect(() => {
    if (still || reduced) {
      drift.value = withTiming(0.42, { duration: motion.slow, easing: Easing.out(Easing.quad) });
      return;
    }
    drift.value = 0.12;
    drift.value = withRepeat(
      withTiming(0.88, { duration: motion.liquid, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
  }, [drift, reduced, still]);

  const bandStyle = useAnimatedStyle(() => {
    const band = Math.max(64, width.value * 0.4);
    return {
      width: band,
      height: height.value * 2.2,
      transform: [
        { translateX: -band * 0.5 + drift.value * (width.value + band) },
        { translateY: -height.value * 0.6 },
      ],
    };
  });

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        width.value = event.nativeEvent.layout.width;
        height.value = event.nativeEvent.layout.height;
      }}
    >
      <LinearGradient
        colors={[
          'rgba(255,255,255,0.10)',
          'rgba(255,255,255,0.03)',
          'rgba(154,242,255,0.035)',
          'rgba(4,6,12,0.10)',
        ]}
        locations={[0, 0.3, 0.68, 1]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View style={[styles.band, bandStyle]}>
        <LinearGradient
          colors={[
            'transparent',
            'rgba(255,255,255,0.07)',
            'rgba(154,242,255,0.05)',
            'transparent',
          ]}
          locations={[0, 0.42, 0.62, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

/**
 * Frosted surface. Real Liquid Glass on iOS 26, a blurred translucent layer
 * everywhere else.
 *
 * On iOS the native material already refracts and draws its own edge, so nothing
 * is layered on top of it — the tint is all it needs. Everywhere else the blur,
 * the tint and the sheen stand in for refraction.
 */
export function Glass({ children, style, radius, intensity = 68, still = false, ...rest }: GlassProps) {
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
    <View style={[styles.clip, styles.frame, clip, style]} {...rest}>
      <BlurView
        intensity={intensity}
        tint="dark"
        blurMethod={BLUR_METHOD}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.tint, clip]} />
      <Sheen still={still} />
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
    borderColor: palette.glassEdge,
  },
  tint: {
    backgroundColor: palette.glass,
  },
  band: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});
