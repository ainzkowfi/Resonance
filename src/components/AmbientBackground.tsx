import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { gradientFor } from '../lib/colors';
import { motion } from '../theme';

/**
 * Full-bleed backdrop that follows the current track.
 *
 * The cover is blown up and blurred past recognition so every album still
 * reads as one soft colour field; a white gradient keeps the light theme
 * legible from status bar to controls. Tracks without art fall back to the
 * pastel gradient derived from the album name.
 */
export function AmbientBackground({ seed, artwork }: { seed: string; artwork?: string }) {
  const target = useMemo(() => gradientFor(seed), [seed]);
  const [base, setBase] = useState(target);
  const fade = useSharedValue(0);

  useEffect(() => {
    if (target[0] === base[0]) return;
    fade.value = 0;
    fade.value = withTiming(1, { duration: motion.slow }, (finished) => {
      if (!finished) return;
      runOnJS(setBase)(target);
      fade.value = 0;
    });
  }, [target, base, fade]);

  const overlayStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={base} style={StyleSheet.absoluteFill} />
      <Animated.View style={[StyleSheet.absoluteFill, overlayStyle]}>
        <LinearGradient colors={target} style={StyleSheet.absoluteFill} />
      </Animated.View>
      {artwork ? (
        <>
          <View style={styles.artworkViewport}>
            <Image
              source={{ uri: artwork }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              contentPosition="center"
              blurRadius={60}
              transition={motion.slow}
              cachePolicy="memory-disk"
            />
          </View>
          <LinearGradient
            colors={[
              'rgba(255,255,255,0.94)',
              'rgba(255,255,255,0.5)',
              'rgba(255,255,255,0.66)',
            ]}
            locations={[0, 0.42, 1]}
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  artworkViewport: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
});
