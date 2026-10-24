import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Artwork } from '../../components/Artwork';
import { LyricsView } from '../../components/LyricsView';
import { ScreenHeader } from '../../components/ScreenHeader';
import { useTrackById } from '../../hooks/useTrackById';
import { useTrackLyrics } from '../../hooks/useTrackLyrics';
import { formatDuration } from '../../lib/format';
import { usePlayerStore } from '../../store/player';
import { font, palette, radius, spacing } from '../../theme';

export default function TrackDetailScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const { track, loading } = useTrackById(id ?? '');
  const lyrics = useTrackLyrics(track);
  const seek = usePlayerStore((state) => state.seek);
  const currentTrack = usePlayerStore((state) => state.currentTrack);

  const details: { label: string; value: string }[] = [];
  if (track) {
    if (track.albumArtist) details.push({ label: 'Album artist', value: track.albumArtist });
    if (track.year) details.push({ label: 'Year', value: String(track.year) });
    if (track.composer) details.push({ label: 'Composer', value: track.composer });
    if (track.conductor) details.push({ label: 'Conductor', value: track.conductor });
    if (track.lyricist) details.push({ label: 'Lyricist', value: track.lyricist });
    if (track.publisher) details.push({ label: 'Publisher', value: track.publisher });
    if (track.copyright) details.push({ label: 'Copyright', value: track.copyright });
    if (track.grouping) details.push({ label: 'Grouping', value: track.grouping });
    if (track.comment) details.push({ label: 'Comment', value: track.comment });
    if (track.encoder) details.push({ label: 'Encoder', value: track.encoder });
    if (track.isrc) details.push({ label: 'ISRC', value: track.isrc });
    if (track.bpm) details.push({ label: 'BPM', value: String(Math.round(track.bpm)) });
    if (track.gain != null) details.push({ label: 'Gain', value: `${track.gain.toFixed(1)} dB` });
    if (track.trackNumber) details.push({ label: 'Track', value: String(track.trackNumber) });
    if (track.discNumber) details.push({ label: 'Disc', value: String(track.discNumber) });
    details.push({ label: 'Length', value: formatDuration(track.duration) });
  }

  const genres = track?.genre ? [track.genre] : [];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader
        back
      />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 48 }]}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <Text style={styles.loading}>Loading…</Text>
        ) : !track ? (
          <Text style={styles.loading}>Track not found.</Text>
        ) : (
          <>
            <Animated.View entering={FadeIn.duration(260)} style={styles.hero}>
              <Artwork uri={track.artwork} size={240} borderRadius={radius.lg} />
              <Text style={styles.title}>{track.title}</Text>
              <Text style={styles.artist}>{track.artist}</Text>
              {track.album ? <Text style={styles.album}>{track.album}</Text> : null}
            </Animated.View>

            {genres.length > 0 ? (
              <Animated.View entering={FadeInDown.duration(220)} style={styles.chips}>
                {genres.map((genre) => (
                  <View key={genre} style={styles.chip}>
                    <Text style={styles.chipText}>{genre}</Text>
                  </View>
                ))}
              </Animated.View>
            ) : null}

            {details.length > 0 ? (
              <Animated.View entering={FadeInDown.delay(60).duration(220)} style={styles.details}>
                {details.map((detail) => (
                  <View key={detail.label} style={styles.detailRow}>
                    <Text style={styles.detailLabel}>{detail.label}</Text>
                    <Text style={styles.detailValue} numberOfLines={1}>
                      {detail.value}
                    </Text>
                  </View>
                ))}
              </Animated.View>
            ) : null}

            {lyrics ? (
              <Animated.View entering={FadeInDown.delay(100).duration(220)} style={styles.section}>
                <Text style={styles.sectionTitle}>Lyrics</Text>
                <View style={styles.lyricsBox}>
                  <LyricsView
                    lyrics={lyrics}
                    scroll={false}
                    onSeek={(seconds) => {
                      if (currentTrack?.id === track.id) seek(seconds);
                    }}
                  />
                </View>
              </Animated.View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  content: {
    paddingHorizontal: 20,
    gap: spacing(6),
  },
  loading: {
    ...font.body,
    color: palette.textFaint,
    textAlign: 'center',
    paddingVertical: 48,
  },
  hero: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing(3),
  },
  title: {
    ...font.title,
    color: palette.text,
    textAlign: 'center',
  },
  artist: {
    ...font.body,
    color: palette.textDim,
  },
  album: {
    ...font.label,
    fontWeight: '500',
    color: palette.textFaint,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
  },
  chipText: {
    ...font.label,
    fontWeight: '500',
    color: palette.textDim,
  },
  details: {
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    paddingVertical: spacing(1),
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  detailLabel: {
    ...font.label,
    fontWeight: '500',
    color: palette.textFaint,
  },
  detailValue: {
    ...font.label,
    color: palette.text,
    flexShrink: 1,
    textAlign: 'right',
  },
  section: {
    gap: spacing(2),
  },
  sectionTitle: {
    ...font.title,
    fontSize: 17,
    color: palette.text,
  },
  lyricsBox: {
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
    paddingVertical: spacing(2),
    minHeight: 200,
  },
});
