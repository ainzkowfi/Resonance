import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { usePlayerStore } from '../store/player';
import { font, palette, radius } from '../theme';
import { Touch } from './Touch';

/** How long a progress note stays before it clears itself. */
const INFO_LIFETIME_MS = 6_000;

/**
 * Why playback stopped, or what the player is doing about it.
 *
 * A track the device cannot decode used to fail silently, which is
 * indistinguishable from a player that simply did not start. The notice is the
 * user-facing half of that fix; the raw text goes to Settings → Diagnostics.
 *
 * Informational notices — mostly "making a playable copy" — clear themselves;
 * an error stays until dismissed, because it is the only explanation the user
 * gets for a track that will not play.
 */
export function PlaybackNoticeLine({ style }: { style?: StyleProp<ViewStyle> }) {
  const notice = usePlayerStore((state) => state.notice);
  const dismiss = usePlayerStore((state) => state.dismissNotice);

  useEffect(() => {
    if (notice?.tone !== 'info') return;
    const timer = setTimeout(dismiss, INFO_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);

  if (!notice) return null;
  const failed = notice.tone === 'error';

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      accessibilityLiveRegion="polite"
      style={[styles.notice, failed ? styles.failed : styles.info, style]}
    >
      <Ionicons
        name={failed ? 'alert-circle' : 'sync'}
        size={16}
        color={failed ? palette.danger : palette.accent}
      />
      <Text style={styles.text} numberOfLines={2}>
        {notice.message}
      </Text>
      <Touch
        style={styles.dismiss}
        haptic="none"
        onPress={dismiss}
        accessibilityLabel="Dismiss message"
      >
        <Ionicons name="close" size={14} color={palette.textFaint} />
      </Touch>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  info: {
    backgroundColor: palette.selection,
    borderColor: palette.glassEdge,
  },
  failed: {
    backgroundColor: 'rgba(255,140,154,0.12)',
    borderColor: 'rgba(255,140,154,0.32)',
  },
  text: {
    ...font.label,
    color: palette.textDim,
    flex: 1,
  },
  dismiss: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
