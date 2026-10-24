import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BOTTOM_BAR_SPACE } from '../../components/bottomBar';
import { ScreenHeader } from '../../components/ScreenHeader';
import { Touch } from '../../components/Touch';
import { clearMetadataCache } from '../../lib/cache';
import { formatDuration } from '../../lib/format';
import { useLibraryStore } from '../../store/library';
import { usePlayerStore } from '../../store/player';
import { font, palette, radius } from '../../theme';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const crossfade = usePlayerStore((state) => state.crossfade);
  const toggleCrossfade = usePlayerStore((state) => state.toggleCrossfade);
  const queueLength = usePlayerStore((state) => state.queue.length);
  const trackCount = useLibraryStore((state) => state.tracks.length);
  const minDuration = useLibraryStore((state) => state.minDuration);
  const setMinDuration = useLibraryStore((state) => state.setMinDuration);
  const hiddenCount = useLibraryStore((state) => state.hidden.length);
  const folder = useLibraryStore((state) => state.folder);
  const scan = useLibraryStore((state) => state.scan);
  const [cacheCleared, setCacheCleared] = useState(false);

  useEffect(() => {
    if (!cacheCleared) return;
    const timer = setTimeout(() => setCacheCleared(false), 2200);
    return () => clearTimeout(timer);
  }, [cacheCleared]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader title="Settings" subtitle="Playback, storage and credits" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Section title="Playback">
          <Row
            icon="swap-horizontal"
            label="Crossfade"
            hint={crossfade ? 'Fades into the next track' : 'Tracks switch instantly'}
            value={crossfade}
            onPress={toggleCrossfade}
          />
        </Section>

        <Section title="Library">
          <Row
            icon="refresh-outline"
            label="Refresh music library"
            hint={folder ? 'Look for tracks added to your folder' : 'Rescan music on this device'}
            onPress={() => void scan()}
          />
          <RangeRow
            icon="funnel-outline"
            label="Hide short tracks"
            hint={
              minDuration === 0
                ? 'Every track is listed'
                : `Tracks under ${formatDuration(minDuration)} are left out`
            }
            value={minDuration}
            max={120}
            onChange={(seconds) => void setMinDuration(seconds)}
          />
          <InfoRow icon="musical-notes" label="Tracks on device" value={String(trackCount)} />
          <Row
            icon="eye-off-outline"
            label="Hidden tracks"
            hint={hiddenCount === 0 ? 'Nothing hidden' : `${hiddenCount} hidden from the list`}
            onPress={() => router.push('/hidden')}
          />
          <InfoRow icon="list" label="Tracks in queue" value={String(queueLength)} />
        </Section>

        <Section title="Storage">
          <Row
            icon="trash-outline"
            label="Clear metadata cache"
            hint={cacheCleared ? 'Cache cleared' : 'Lyrics and tags are cached for 7 days'}
            onPress={() => {
              void clearMetadataCache();
              setCacheCleared(true);
            }}
          />
        </Section>

        <Section title="Credits">
          <Text style={styles.credits}>
            Metadata comes from LRCLIB, lyrics.ovh, iTunes, Deezer, MusicBrainz and the Cover Art
            Archive. Artwork is never taken from Last.fm, whose licence forbids it.
          </Text>
          <Text style={styles.credits}>
            Playback uses expo-audio. Version {Constants.expoConfig?.version ?? '1.0.0'}.
          </Text>
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Animated.View entering={FadeInDown.duration(240)} style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.card}>{children}</View>
    </Animated.View>
  );
}

function Row({
  icon,
  label,
  hint,
  value,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  value?: boolean;
  onPress: () => void;
}) {
  return (
    <Touch style={styles.row} onPress={onPress} haptic="none">
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={18} color={palette.textDim} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowHint} numberOfLines={1}>
          {hint}
        </Text>
      </View>
      {value === undefined ? null : (
        <View style={[styles.toggle, value && styles.toggleOn]}>
          <View style={[styles.knob, value && styles.knobOn]} />
        </View>
      )}
    </Touch>
  );
}

function RangeRow({
  icon,
  label,
  hint,
  value,
  max,
  onChange,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const progress = useSharedValue(ratio);
  useEffect(() => {
    progress.value = ratio;
  }, [progress, ratio]);
  const fillStyle = useAnimatedStyle(() => ({ width: width * progress.value }));
  const knobStyle = useAnimatedStyle(() => ({ left: width * progress.value - 9 }));
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .activeOffsetX([-8, 8])
        .failOffsetY([-14, 14])
        .onBegin((event) => {
          if (width > 0) progress.value = Math.max(0, Math.min(1, event.x / width));
        })
        .onUpdate((event) => {
          if (width > 0) progress.value = Math.max(0, Math.min(1, event.x / width));
        })
        .onEnd(() => {
          runOnJS(onChange)(Math.round((progress.value * max) / 5) * 5);
        }),
    [max, onChange, progress, width],
  );

  return (
    <View style={styles.rangeRow}>
      <View style={styles.row}>
        <View style={styles.rowIcon}>
          <Ionicons name={icon} size={18} color={palette.textDim} />
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text style={styles.rowHint} numberOfLines={1}>
            {hint}
          </Text>
        </View>
        <Text style={styles.rowValue}>{value === 0 ? 'Off' : formatDuration(value)}</Text>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.sliderHit}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          accessibilityLabel={`${label}, ${value} seconds`}
        >
          <View style={styles.sliderTrack}>
            <Animated.View style={[styles.sliderFill, fillStyle]} />
          </View>
          <Animated.View style={[styles.sliderKnob, knobStyle]} />
        </View>
      </GestureDetector>
    </View>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={18} color={palette.textDim} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: BOTTOM_BAR_SPACE + 24,
    gap: 20,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    ...font.caption,
    color: palette.textFaint,
    paddingHorizontal: 4,
  },
  card: {
    borderRadius: radius.lg,
    backgroundColor: palette.surface,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 60,
  },
  rowIcon: {
    width: 32,
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    ...font.body,
    fontSize: 15,
    color: palette.text,
  },
  rowHint: {
    ...font.label,
    fontWeight: '500',
    color: palette.textDim,
  },
  rowValue: {
    ...font.label,
    color: palette.textDim,
  },
  toggle: {
    width: 46,
    height: 28,
    borderRadius: 14,
    padding: 3,
    backgroundColor: palette.surfaceHi,
    justifyContent: 'center',
  },
  toggleOn: {
    backgroundColor: palette.accent,
  },
  knob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: palette.textFaint,
  },
  knobOn: {
    alignSelf: 'flex-end',
    backgroundColor: '#fff',
  },
  rangeRow: {
    paddingBottom: 6,
  },
  sliderHit: {
    height: 30,
    marginHorizontal: 16,
    justifyContent: 'center',
  },
  sliderTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.surfaceHi,
    overflow: 'hidden',
  },
  sliderFill: {
    height: 4,
    backgroundColor: palette.accent,
  },
  sliderKnob: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: palette.bgElevated,
    borderWidth: 1,
    borderColor: palette.borderHi,
  },
  credits: {
    ...font.body,
    fontWeight: '500',
    color: palette.textDim,
    lineHeight: 21,
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
});
