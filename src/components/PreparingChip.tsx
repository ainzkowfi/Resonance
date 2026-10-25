import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { font, palette, radius } from '../theme';

/**
 * Marks the track whose playable copy is being produced right now.
 *
 * The conversion happens because the platform cannot open the original file,
 * and it takes a few seconds — long enough that a row which does nothing when
 * tapped looks broken. The chip replaces the duration so the row says what is
 * happening without moving anything else.
 */
export function PreparingChip() {
  return (
    <View style={styles.chip} accessibilityLabel="Preparing a playable copy">
      <ActivityIndicator size="small" color={palette.accent} />
      <Text style={styles.text}>Preparing</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: palette.selection,
  },
  text: {
    ...font.caption,
    color: palette.accent,
  },
});
