import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';

import { selfTestWav } from './decodeCheck';
import type { CheckOutcome, FeatureCheck } from './featureChecks';
import { applyLibraryFilter, EMPTY_FILTER, sanitizeTracks } from './filter';
import { isExcluded } from './folderExclusions';
import { targetFromSamples, trackGainDb, volumeForGain } from './leveling';
import { activeLineIndex, parseLrc } from './lrc';
import { basename } from './lyrics';
import { leadSkip, tailOut } from './silence';
import { parseDuration, sniffFormat } from './tags';
import { loadNativeAudio, nativeAudioLoadFailure } from '../media/module';
import { runDecodeSelfTest } from '../media/selfTest';
import { useDiagnosticsStore } from '../store/diagnostics';
import { useLibraryStore } from '../store/library';
import { usePlayerStore } from '../store/player';
import type { Track } from '../types/track';

/**
 * Runs the Settings feature checklist against this device.
 *
 * The point is to answer "which part is broken?" without a debugger: every
 * check calls the same code the app uses for that feature — the real file API,
 * the real tag reader, the real native decode the waveform pipeline runs — and
 * reports what came back. A failure is written to the diagnostics log as well,
 * so it survives in "Share error log" next to whatever the crash produced.
 */

export interface FeatureAuditOptions {
  /** Called once, with how many checks will run. */
  onStart?: (total: number) => void;
  /** Called before a check starts, with its label. */
  onBefore?: (label: string) => void;
  /** Called as each check finishes. */
  onResult?: (check: FeatureCheck) => void;
}

interface CheckDefinition {
  id: string;
  label: string;
  intent: string;
  run: () => Promise<CheckOutcome>;
}

const SELF_CHECK_DIR = 'self-check';

function sampleTrack(uri: string, duration: number, patch: Partial<Track> = {}): Track {
  return {
    id: `self-check-${uri}`,
    source: 'local',
    uri,
    title: uri,
    artist: 'Self check',
    duration,
    ...patch,
  };
}

function firstFailure(checks: readonly [boolean, string][]): string | undefined {
  for (const [condition, message] of checks) {
    if (!condition) return message;
  }
  return undefined;
}

function judge(checks: readonly [boolean, string][], success: string, detail?: string): CheckOutcome {
  const failure = firstFailure(checks);
  return failure ? { status: 'fail', note: failure, detail } : { status: 'pass', note: success };
}

/** Anything thrown by a check becomes a failure with the error text attached. */
function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

const DEFINITIONS: CheckDefinition[] = [
  {
    id: 'storage',
    label: 'Saved settings',
    intent: 'Write a value to device storage and read it back',
    run: async () => {
      const key = 'resonance:self-check';
      const value = String(Date.now());
      await AsyncStorage.setItem(key, value);
      const read = await AsyncStorage.getItem(key);
      await AsyncStorage.removeItem(key);
      const removed = await AsyncStorage.getItem(key);
      return judge(
        [
          [read === value, 'The value read back did not match the one written'],
          [removed === null, 'The test key could not be removed'],
        ],
        'AsyncStorage round trip succeeded',
      );
    },
  },
  {
    id: 'files',
    label: 'Cache files',
    intent: 'Create a file in the cache directory, read it, delete it',
    run: async () => {
      const directory = new Directory(Paths.cache, SELF_CHECK_DIR);
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
      const file = new File(directory, 'probe.bin');
      const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      try {
        await file.write(payload);
        const bytes = await file.bytes();
        return judge(
          [
            [bytes.length === payload.length, `Read back ${bytes.length} of ${payload.length} bytes`],
            [bytes[7] === 8, 'The bytes read back were not the ones written'],
          ],
          `Wrote and read ${bytes.length} bytes in the cache directory`,
        );
      } finally {
        try {
          if (file.exists) file.delete();
        } catch {
          // A leftover probe file costs nothing.
        }
      }
    },
  },
  {
    id: 'tags',
    label: 'Tag and duration reading',
    intent: 'Identify a container and read its length from the header',
    run: async () => {
      const wav = selfTestWav({ seconds: 2 });
      const format = sniffFormat(wav);
      const duration = parseDuration(wav, 'wav', wav.length);
      return judge(
        [
          [format === 'wav', `A generated WAV was identified as "${format}"`],
          [duration === 2, `The header reported ${String(duration)} s instead of 2 s`],
        ],
        'A WAV header was identified and its length read',
      );
    },
  },
  {
    id: 'lyrics',
    label: 'Synced lyrics',
    intent: 'Parse LRC timestamps and follow the line for a position',
    run: async () => {
      const lines = parseLrc('[00:01.50]first\n[00:04.00]second\n[00:09.25]third');
      const atStart = activeLineIndex(lines, 0);
      const midway = activeLineIndex(lines, 5);
      const late = activeLineIndex(lines, 30);
      return judge(
        [
          [lines.length === 3, `Parsed ${lines.length} timed lines out of 3`],
          [Math.abs((lines[0]?.time ?? 0) - 1.5) < 0.001, 'The first timestamp was misread'],
          [atStart === -1, 'A position before the first line selected a line'],
          [midway === 1, `5 s selected line ${midway} instead of line 1`],
          [late === 2, 'A position past the last line did not clamp to it'],
        ],
        'LRC timestamps parsed and highlighted correctly',
      );
    },
  },
  {
    id: 'filter',
    label: 'Library filters',
    intent: 'Short-track limit, hidden tracks, metadata edits and folder exclusions',
    run: async () => {
      const short = sampleTrack('short.mp3', 10);
      const long = sampleTrack('long.mp3', 200);
      const library = [short, long];

      const all = applyLibraryFilter(library, EMPTY_FILTER).length;
      const minDuration = applyLibraryFilter(library, { ...EMPTY_FILTER, minDuration: 120 });
      const hidden = applyLibraryFilter(library, { ...EMPTY_FILTER, hidden: [short.uri] });
      const renamed = applyLibraryFilter(library, {
        ...EMPTY_FILTER,
        overrides: { [short.uri]: { title: 'Renamed' } },
      })[0]?.title;
      const sanitized = sanitizeTracks([{ id: 'a', uri: 'a.mp3' }, null, { uri: 'no-id.mp3' }]);

      return judge(
        [
          [all === 2, 'The default filter dropped a track'],
          [
            minDuration.length === 1 && minDuration[0]?.uri === long.uri,
            'The short-track limit did not apply',
          ],
          [hidden.length === 1 && hidden[0]?.uri === long.uri, 'Hiding a track did not remove it'],
          [renamed === 'Renamed', 'A metadata edit did not replace the scanned title'],
          [sanitized.length === 1, 'A stored track record with no id was not discarded'],
          [
            sanitized[0]?.artist === 'Unknown Artist',
            'A stored track with no artist was not given a fallback',
          ],
          [isExcluded('/Music/Skip/Live', ['/Music/Skip']), 'A nested folder was not excluded'],
          [!isExcluded('/Music/Skipper', ['/Music/Skip']), 'A sibling folder was excluded by mistake'],
        ],
        'Filters, edits, exclusions and stored records all behaved',
      );
    },
  },
  {
    id: 'leveling',
    label: 'Leveling and silence skipping',
    intent: 'Gain maths and the silence thresholds the player uses',
    run: async () => {
      const gain = trackGainDb({ rmsDb: -10, targetDb: -16 });
      const volume = volumeForGain(gain);
      return judge(
        [
          [targetFromSamples([]) === -16, 'The fallback loudness target changed'],
          [gain === -6, `A −10 dBFS track was given ${gain} dB against a −16 dB target`],
          [Math.abs(volume - 0.5012) < 0.001, 'A 6 dB cut did not halve the volume'],
          [trackGainDb({ rmsDb: -24, targetDb: -16 }) === 0, 'A quiet track was boosted'],
          [leadSkip(4, 0) === 4, 'A long intro was not skipped'],
          [leadSkip(4, 30) === 0, 'A resume past the intro was undone'],
          [tailOut(200, 5) === 195, 'A long outro was not cut short'],
          [tailOut(200, 1) === 0, 'A short outro was cut short'],
        ],
        'Gain and silence rules produced the expected values',
      );
    },
  },
  {
    id: 'codecs',
    label: 'Device codec module',
    intent: 'Load the native decoder and read the codecs it reports',
    run: async () => {
      const module = await loadNativeAudio();
      if (!module) {
        return {
          status: 'fail',
          note: 'The native audio module is not in this build',
          detail: nativeAudioLoadFailure() ?? 'requireNativeModule returned nothing.',
        };
      }
      const decoders = module.listDecoders();
      const encoders = module.listEncoders();
      return judge(
        [[decoders.length > 0, 'The module loaded but reports no decoders']],
        `MediaCodec reports ${decoders.length} decoders and ${encoders.length} encoders`,
      );
    },
  },
  {
    id: 'decode',
    label: 'Waveform decode',
    intent: 'Decode audio and derive waveform peaks, loudness and silence',
    run: async () => {
      const report = await runDecodeSelfTest();
      if (!report.ok) {
        return { status: 'fail', note: report.message, detail: report.detail };
      }
      return {
        status: 'pass',
        note: `${report.message}, ${report.peaks} waveform columns`,
      };
    },
  },
  {
    id: 'library',
    label: 'Library scan',
    intent: 'Tracks are indexed and visible after the filters',
    run: async () => {
      const state = useLibraryStore.getState();
      if (state.entries.length === 0) {
        return {
          status: 'skip',
          note: state.folder
            ? 'The music folder is set but no audio files were found'
            : 'No folder chosen and no media scan has run yet',
        };
      }
      return judge(
        [[state.tracks.length > 0, `${state.entries.length} files were indexed but none are listed`]],
        `${state.tracks.length} playable of ${state.entries.length} indexed`,
      );
    },
  },
  {
    id: 'file-access',
    label: 'Library file access',
    intent: 'The first indexed track can still be reached on disk',
    run: async () => {
      const first = useLibraryStore.getState().entries[0];
      if (!first) return { status: 'skip', note: 'Nothing has been scanned yet' };
      const name = basename(first.uri);
      try {
        const file = new File(first.uri);
        const exists = file.exists;
        return judge(
          [[exists, `${name} is no longer reachable — reselect the music folder`]],
          `${name} is reachable`,
        );
      } catch (error) {
        return {
          status: 'fail',
          note: `${name} could not be opened`,
          detail: describeThrown(error),
        };
      }
    },
  },
  {
    id: 'playback',
    label: 'Playback',
    intent: 'The engine opened the current track and reported its length',
    run: async () => {
      const state = usePlayerStore.getState();
      const track = state.currentTrack;
      if (!track) return { status: 'skip', note: 'Nothing has been played in this session yet' };
      if (state.duration > 0 || state.position > 0) {
        return {
          status: 'pass',
          note: `“${track.title}” opened — ${Math.round(state.duration)} s reported`,
        };
      }
      if (state.isPlaying) {
        return {
          status: 'fail',
          note: `The engine has not opened “${track.title}”`,
          detail: 'The app believes it is playing but no duration or position has arrived.',
        };
      }
      return {
        status: 'skip',
        note: 'The current track has not played yet — start it, then run again',
      };
    },
  },
];

/** How many checks the list holds, for the Settings row. */
export const FEATURE_CHECK_COUNT = DEFINITIONS.length;

export async function runFeatureChecks(
  options: FeatureAuditOptions = {},
): Promise<FeatureCheck[]> {
  options.onStart?.(DEFINITIONS.length);
  const results: FeatureCheck[] = [];

  for (const definition of DEFINITIONS) {
    options.onBefore?.(definition.label);
    const started = Date.now();
    let outcome: CheckOutcome;

    try {
      outcome = await definition.run();
    } catch (error) {
      outcome = {
        status: 'fail',
        note: 'The check could not finish',
        detail: describeThrown(error),
      };
    }

    const check: FeatureCheck = {
      id: definition.id,
      label: definition.label,
      intent: definition.intent,
      status: outcome.status,
      note: outcome.note,
      detail: outcome.detail,
      ms: Date.now() - started,
    };

    if (check.status === 'fail') {
      useDiagnosticsStore
        .getState()
        .addIssue('self-check', `${check.label}: ${check.note}`, check.detail);
    }

    results.push(check);
    options.onResult?.(check);
  }

  return results;
}
