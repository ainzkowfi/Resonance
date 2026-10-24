import { useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Artwork } from '../../components/Artwork';
import { LyricsView } from '../../components/LyricsView';
import { ScreenHeader } from '../../components/ScreenHeader';
import { TrackRow } from '../../components/TrackRow';
import { useTrackById } from '../../hooks/useTrackById';
import { useTrackInfo } from '../../hooks/useTrackInfo';
import { formatDate, formatDuration } from '../../lib/format';
import { usePlayerStore } from '../../store/player';
import { openPlayer } from '../../store/playerSurface';
import { font, palette, radius, spacing } from '../../theme';

export default function TrackDetailScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const { track, loading } = useTrackById(id ?? '');
  const info = useTrackInfo(track);
  const playTracks = usePlayerStore((state) => state.playTracks);
  const seek = usePlayerStore((state) => state.seek);
  const currentTrack = usePlayerStore((state) => state.currentTrack);

  const details: { label: string; value: string }[] = [];
  if (info) {
    if (info.albumYear) details.push({ label: 'Released', value: String(info.albumYear) });
    if (info.releaseDate) {
      details.push({ label: 'Release date', value: formatDate(info.releaseDate) ?? info.releaseDate });
    }
    if (info.label) details.push({ label: 'Label', value: info.label });
    if (track?.isrc) details.push({ label: 'ISRC', value: track.isrc });
    if (track?.bpm) details.push({ label: 'BPM', value: String(Math.round(track.bpm)) });
    if (track?.gain != null) details.push({ label: 'Gain', value: `${track.gain.toFixed(1)} dB` });
    if (track?.trackNumber) details.push({ label: 'Track', value: String(track.trackNumber) });
    if (track?.discNumber) details.push({ label: 'Disc', value: String(track.discNumber) });
    details.push({ label: 'Length', value: formatDuration(info.track.duration) });
  }

  const genres = [...new Set([info?.track.genre, ...(info?.artistGenres ?? [])].filter(Boolean))] as string[];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader
        title={track?.title ?? 'Track'}
        subtitle={track?.artist}
        back
        action={
          track
            ? {
                icon: 'play',
                label: 'Play this track',
                onPress: () => {
                  playTracks([track]);
                  openPlayer();
                },
              }
            : undefined
        }
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
              <Artwork uri={info?.track.artwork ?? track.artwork} size={240} borderRadius={radius.lg} />
              <Text style={styles.title}>{info?.track.title ?? track.title}</Text>
              <Text style={styles.artist}>{info?.track.artist ?? track.artist}</Text>
              {info?.track.album ? <Text style={styles.album}>{info.track.album}</Text> : null}
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

            {info?.artistBio ? (
              <Animated.View entering={FadeInDown.delay(100).duration(220)} style={styles.section}>
                <Text style={styles.sectionTitle}>About the artist</Text>
                <Text style={styles.bio}>{info.artistBio}</Text>
              </Animated.View>
            ) : null}

            {info?.providers.length ? (
              <Animated.View entering={FadeInDown.delay(140).duration(220)} style={styles.section}>
                <Text style={styles.sectionTitle}>Sources</Text>
                <View style={styles.chips}>
                  {info.providers.map((provider) => (
                    <View key={provider} style={styles.chip}>
                      <Text style={styles.chipText}>{provider}</Text>
                    </View>
                  ))}
                </View>
              </Animated.View>
            ) : null}

            {info?.lyrics ? (
              <Animated.View entering={FadeInDown.delay(180).duration(220)} style={styles.section}>
                <Text style={styles.sectionTitle}>Lyrics</Text>
                <View style={styles.lyricsBox}>
                  <LyricsView
                    lyrics={info.lyrics}
                    scroll={false}
                    onSeek={(seconds) => {
                      if (currentTrack?.id === track.id) seek(seconds);
                    }}
                  />
                </View>
              </Animated.View>
            ) : null}

            {info?.similar.length ? (
              <Animated.View entering={FadeInDown.delay(220).duration(220)} style={styles.section}>
                <Text style={styles.sectionTitle}>Similar tracks</Text>
                {info.similar.map((similar, index) => (
                  <TrackRow
                    key={similar.id}
                    track={similar}
                    onPress={() => {
                      playTracks(info.similar, index);
                      openPlayer();
                    }}
                  />
                ))}
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
  bio: {
    ...font.body,
    fontWeight: '500',
    lineHeight: 22,
    color: palette.textDim,
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
