import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
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
import { runCapabilityProbe } from '../../ffmpeg/probe';
import { getFFmpegInfo } from '../../ffmpeg/waveform';
import { MAX_CROSSFADE_SECONDS } from '../../lib/crossfade';
import { formatDuration } from '../../lib/format';
import { summarizeHandoffs } from '../../lib/handoff';
import { targetFromSamples } from '../../lib/leveling';
import { MAX_TRACKS_PER_RUN } from '../../lib/analysisQueue';
import { useAnalysisRunStore } from '../../store/analysis';
import { formatIssues, formatTime, useDiagnosticsStore } from '../../store/diagnostics';
import { useLibraryStore } from '../../store/library';
import { usePlayerStore } from '../../store/player';
import { font, palette, radius } from '../../theme';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queueLength = usePlayerStore((state) => state.queue.length);
  const trackCount = useLibraryStore((state) => state.tracks.length);
  const minDuration = useLibraryStore((state) => state.minDuration);
  const setMinDuration = useLibraryStore((state) => state.setMinDuration);
  const hiddenCount = useLibraryStore((state) => state.hidden.length);
  const excludedCount = useLibraryStore((state) => state.excludedFolders.length);
  const folder = useLibraryStore((state) => state.folder);
  const scan = useLibraryStore((state) => state.scan);
  const issues = useDiagnosticsStore((state) => state.issues);
  const clearIssues = useDiagnosticsStore((state) => state.clearIssues);
  const probe = useDiagnosticsStore((state) => state.probe);
  const handoffs = useDiagnosticsStore((state) => state.handoffs);
  const clearHandoffs = useDiagnosticsStore((state) => state.clearHandoffs);
  const handoffSummary = useMemo(() => summarizeHandoffs(handoffs), [handoffs]);
  const leveling = usePlayerStore((state) => state.leveling);
  const setLeveling = usePlayerStore((state) => state.setLeveling);
  const skipSilence = usePlayerStore((state) => state.skipSilence);
  const setSkipSilence = usePlayerStore((state) => state.setSkipSilence);
  const crossfade = usePlayerStore((state) => state.crossfade);
  const setCrossfade = usePlayerStore((state) => state.setCrossfade);
  const entries = useLibraryStore((state) => state.entries);
  const running = useAnalysisRunStore((state) => state.running);
  const analyzedCount = useAnalysisRunStore((state) => state.done);
  const runTotal = useAnalysisRunStore((state) => state.total);
  const runCurrent = useAnalysisRunStore((state) => state.current);
  const startAnalysis = useAnalysisRunStore((state) => state.start);
  const cancelAnalysis = useAnalysisRunStore((state) => state.cancel);
  const analyzedTotal = useAnalysisRunStore((state) => state.analyzed);
  const countAnalyzed = useAnalysisRunStore((state) => state.countAnalyzed);
  const runPercent = runTotal > 0 ? Math.round((analyzedCount / runTotal) * 100) : 0;

  useEffect(() => {
    countAnalyzed(entries);
  }, [countAnalyzed, entries]);
  const levels = usePlayerStore((state) => state.levels);
  const measured = Object.keys(levels).length;
  const targetDb = useMemo(() => targetFromSamples(Object.values(levels)), [levels]);
  const [probing, setProbing] = useState(false);
  const [ffmpeg, setFfmpeg] = useState('Checking…');

  useEffect(() => {
    let active = true;
    void getFFmpegInfo().then((value) => {
      if (active) setFfmpeg(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const handoffValue = handoffSummary
    ? handoffSummary.preloaded && handoffSummary.cold
      ? `${handoffSummary.preloaded.medianMs} ms preloaded · ${handoffSummary.cold.medianMs} ms cold`
      : `${handoffSummary.medianMs} ms · ${handoffSummary.count} measured`
    : 'Not measured';
  const handoffText = handoffSummary
    ? [
        `${handoffSummary.medianMs} ms median, ${handoffSummary.worstMs} ms worst, ${handoffSummary.count} samples`,
        handoffSummary.preloaded
          ? `preloaded: ${handoffSummary.preloaded.medianMs} ms over ${handoffSummary.preloaded.count}`
          : 'preloaded: none',
        handoffSummary.cold
          ? `cold: ${handoffSummary.cold.medianMs} ms over ${handoffSummary.cold.count}`
          : 'cold: none',
      ].join(' · ')
    : 'not measured';
  const diagnostics = `Resonance diagnostics\nFFmpeg: ${ffmpeg}\nTrack handoff: ${handoffText}\n${Platform.OS} ${String(
    Platform.Version,
  )}\n\n${formatIssues(issues)}`;

  const capabilityHint = probing
    ? 'Asking the binary on this device…'
    : probe
      ? `Checked ${formatTime(probe.at)}`
      : 'Lists what this build has, then encodes a test clip';

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScreenHeader title="Settings" subtitle="Playback, library and credits" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
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
          <Row
            icon="remove-circle-outline"
            label="Excluded folders"
            hint={
              excludedCount === 0
                ? 'Folders a folder scan can skip'
                : `${excludedCount} skipped when scanning`
            }
            onPress={() => router.push('/excluded')}
          />
          <InfoRow icon="list" label="Tracks in queue" value={String(queueLength)} />
        </Section>

        <Section title="Analysis">
          <InfoRow
            icon="bar-chart-outline"
            label="Tracks analysed"
            value={
              analyzedTotal == null ? 'Counting…' : `${analyzedTotal} / ${entries.length}`
            }
          />
          <Row
            icon="analytics-outline"
            label={running ? 'Analyzing…' : 'Analyze library'}
            hint={
              running
                ? `${analyzedCount} of ${runTotal}${runCurrent ? ` · ${runCurrent}` : ''}`
                : `Waveforms, levels and silence for up to ${MAX_TRACKS_PER_RUN} tracks`
            }
            onPress={() => startAnalysis(entries)}
          />
          {running ? (
            <>
              <View style={styles.runBar}>
                <View style={[styles.runFill, { width: `${runPercent}%` }]} />
              </View>
              <Row
                icon="close-circle-outline"
                label="Cancel analysis"
                hint="Stops once the current track finishes decoding"
                onPress={cancelAnalysis}
              />
            </>
          ) : null}
        </Section>

        <Section title="Playback">
          <Row
            icon="volume-medium-outline"
            label="Volume leveling"
            hint={
              leveling
                ? `${measured} track${measured === 1 ? '' : 's'} measured · playing at ${targetDb.toFixed(0)} dB`
                : 'Turn loud tracks down so the next one does not jump'
            }
            value={leveling}
            onPress={() => void setLeveling(!leveling)}
          />
          {leveling ? (
            <Text style={styles.note}>
              Only turns tracks down. Quiet masters are not boosted, because the player cannot exceed
              full volume.
            </Text>
          ) : null}
          <Row
            icon="play-forward-outline"
            label="Skip silence"
            hint={
              skipSilence
                ? 'Long intros and outros are jumped instead of played out'
                : 'Skips more than 2 seconds of silence at either end'
            }
            value={skipSilence}
            onPress={() => void setSkipSilence(!skipSilence)}
          />
          <RangeRow
            icon="swap-horizontal-outline"
            label="Crossfade"
            hint={
              crossfade === 0
                ? 'Tracks change with a hard cut'
                : `Blends the last ${crossfade} s of a track into the next`
            }
            value={crossfade}
            max={MAX_CROSSFADE_SECONDS}
            step={1}
            onChange={setCrossfade}
          />
        </Section>

        <Section title="Diagnostics">
          <InfoRow icon="hardware-chip-outline" label="FFmpeg" value={ffmpeg} />
          <Row
            icon="search-outline"
            label={probing ? 'Checking capabilities…' : 'Check FFmpeg capabilities'}
            hint={capabilityHint}
            onPress={() => {
              if (probing) return;
              setProbing(true);
              void runCapabilityProbe().finally(() => setProbing(false));
            }}
          />
          {probe ? (
            <View style={styles.logBlock}>
              <View style={styles.capRow}>
                <Ionicons
                  name={probe.selfTest.ok ? 'checkmark-circle' : 'close-circle'}
                  size={15}
                  color={probe.selfTest.ok ? palette.accentAlt : palette.textFaint}
                />
                <View style={styles.capText}>
                  <Text style={styles.capLabel}>AAC / M4A export round trip</Text>
                  <Text style={styles.capNote} numberOfLines={2}>
                    {probe.selfTest.message}
                  </Text>
                </View>
              </View>
              {probe.capabilities.map((capability) => (
                <View key={capability.label} style={styles.capRow}>
                  <Ionicons
                    name={capability.ok ? 'checkmark-circle' : 'close-circle'}
                    size={15}
                    color={capability.ok ? palette.accentAlt : palette.textFaint}
                  />
                  <View style={styles.capText}>
                    <Text style={styles.capLabel}>{capability.label}</Text>
                    <Text style={styles.capNote} numberOfLines={2}>
                      {capability.note}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          {probe ? (
            <Row
              icon="clipboard-outline"
              label="Share capability report"
              hint={`FFmpeg ${probe.version}`}
              onPress={() => void Share.share({ message: probe.report })}
            />
          ) : null}
          <InfoRow icon="timer-outline" label="Track handoff" value={handoffValue} />
          <Text style={styles.note}>
            Pipeline gap from the previous track finishing to the next one starting, crossfades
            excluded. “Preloaded” means the next player was already open; “cold” means it was
            created at the boundary. Trailing silence inside the file is on top of both.
          </Text>
          {handoffs.length > 0 ? (
            <Row
              icon="trash-outline"
              label="Clear handoff samples"
              hint={`${handoffs.length} recorded`}
              onPress={clearHandoffs}
            />
          ) : null}
          <View style={styles.logBlock}>
            <Text style={styles.logTitle}>Recent problems</Text>
            <Text selectable style={styles.logText}>
              {formatIssues(issues)}
            </Text>
          </View>
          <Row
            icon="share-outline"
            label="Share error log"
            hint="Send the log somewhere you can paste from"
            onPress={() => void Share.share({ message: diagnostics })}
          />
          {issues.length > 0 ? (
            <Row
              icon="trash-outline"
              label="Clear error log"
              hint={`${issues.length} recorded`}
              onPress={clearIssues}
            />
          ) : null}
        </Section>

        <Section title="Credits">
          <Text style={styles.credits}>
            Resonance scans local audio files and reads their embedded tags and artwork. Music search,
            playback and lyrics stay on this device; no online catalog or lyrics service is used.
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
  step = 5,
  onChange,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  value: number;
  max: number;
  step?: number;
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
          runOnJS(onChange)(Math.round((progress.value * max) / step) * step);
        }),
    [max, onChange, progress, step, width],
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
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
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
    flexShrink: 1,
    textAlign: 'right',
  },
  logBlock: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },
  logTitle: {
    ...font.caption,
    color: palette.textFaint,
  },
  logText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
    lineHeight: 16,
    color: palette.textDim,
  },
  runBar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.surfaceHi,
    overflow: 'hidden',
    marginHorizontal: 14,
    marginTop: 2,
    marginBottom: 10,
  },
  runFill: {
    height: 4,
    backgroundColor: palette.accent,
  },
  note: {
    ...font.label,
    fontWeight: '500',
    color: palette.textFaint,
    lineHeight: 17,
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
    paddingTop: 10,
  },
  capRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 3,
  },
  capText: {
    flex: 1,
    gap: 1,
  },
  capLabel: {
    ...font.label,
    fontWeight: '600',
    color: palette.text,
  },
  capNote: {
    ...font.label,
    fontWeight: '500',
    fontSize: 11,
    lineHeight: 15,
    color: palette.textFaint,
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
