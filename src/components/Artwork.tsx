import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { palette, radius } from '../theme';

export interface ArtworkProps {
  uri?: string;
  size: number;
  borderRadius?: number;
}

/** Album art with a graceful fallback when a track has no embedded cover. */
export function Artwork({ uri, size, borderRadius = radius.md }: ArtworkProps) {
  if (!uri) {
    return (
      <View
        style={[
          styles.fallback,
          { width: size, height: size, borderRadius },
        ]}
      >
        <Ionicons name="musical-note" size={size * 0.38} color={palette.textFaint} />
      </View>
    );
  }
  return (
    <View style={[styles.imageFrame, { width: size, height: size, borderRadius }]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        transition={220}
        cachePolicy="memory-disk"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surfaceHi,
  },
  imageFrame: {
    overflow: 'hidden',
    backgroundColor: palette.surfaceHi,
  },
});
