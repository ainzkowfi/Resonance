import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { formatDuration } from '../lib/format';
import { usePlayerStore } from '../store/player';
import { font, palette, radius } from '../theme';
import type { Track } from '../types/track';
import { Artwork } from './Artwork';
import { Touch } from './Touch';
import { openTrackMenu } from './TrackMenu';

export interface TrackRowProps {
  track: Track;
  onPress: () => void;
  onLongPress?: () => void;
  /** Overrides the default duration chip. */
  trailing?: ReactNode;
  subtitle?: string;
}

export function TrackRow({ track, onPress, onLongPress, trailing, subtitle }: TrackRowProps) {
  const current = usePlayerStore((state) => state.currentTrack?.id === track.id);

  return (
    <Touch
      style={[styles.row, current && styles.rowCurrent]}
      onPress={onPress}
      onLongPress={
        onLongPress ?? (track.source === 'local' ? () => openTrackMenu(track) : undefined)
      }
      haptic="none"
    >
      <Artwork uri={track.artwork} size={48} />
      <View style={styles.text}>
        <Text style={[styles.title, current && styles.titleCurrent]} numberOfLines={1}>
          {track.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle ?? [track.artist, track.album].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {trailing ?? <Text style={styles.duration}>{formatDuration(track.duration)}</Text>}
    </Touch>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 64,
  },
  rowCurrent: {
    backgroundColor: palette.selectionStrong,
    borderRadius: radius.md,
  },
  text: {
    flex: 1,
    gap: 3,
  },
  title: {
    ...font.body,
    fontSize: 16,
    color: palette.text,
  },
  titleCurrent: {
    color: palette.accent,
  },
  subtitle: {
    ...font.label,
    fontWeight: '500',
    color: palette.textDim,
  },
  duration: {
    ...font.label,
    color: palette.textFaint,
  },
});
