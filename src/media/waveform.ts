import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { stableId } from '../lib/format';
import { analyzeWav } from '../lib/wav';
import { describeError, useDiagnosticsStore } from '../store/diagnostics';
import { loadNativeAudio, nativeAudioLoadFailure, type NativeAudioModule } from './module';
import { toPath } from './paths';
import { stageReadableSource } from './source';

/**
 * Per-track audio analysis, computed on device.
 *
 * The device decoder (MediaCodec, via `src/native/MediaAudioModule.kt`) turns a
 * track into a tiny mono WAV (8 kHz, 16-bit) and everything is derived in JS
 * from those samples. One decode yields all of it: waveform peaks, integrated
 * loudness for leveling, and how much near-silence sits at each end.
 *
 * This lands after two earlier attempts. `showwavespic` needed an FFmpeg filter
 * the packaged build did not have, and the `ffmpeg-expo` binary crashed the app
 * outright because it could not actually decode. MediaCodec is what the system
 * player itself uses, so a track that plays here decodes here.
 */

export interface TrackAnalysis {
  /** Normalised 0..1 peak per column. */
  peaks: number[];
  /** dBFS RMS over non-silent frames; the leveling input. */
  rmsDb: number;
  /** dBFS sample peak. */
  peakDb: number;
  /** Seconds of near-silence at the start. */
  lead: number;
  /** Seconds of near-silence at the end. */
  tail: number;
}

/**
 * Stored columns. Deliberately far more than any screen shows: the scrubber
 * resamples to its own width, so a layout change never needs a new decode.
 */
const CACHE_VERSION = 4;
const BARS = 512;
const SAMPLE_RATE = 8_000;
/** Only the first 15 minutes are analysed: 14 MB of PCM, enough for any song. */
const MAX_SECONDS = 900;
const CRASH_KEY = 'waveform:pending-run';
const WAVEFORM_DIR = 'waveforms';
const TEMP_DIR = 'waveform-tmp';

/** Set for one session after a crash marker is found, so we never loop. */
let disabledForSession = false;
const inflight = new Map<string, Promise<TrackAnalysis | undefined>>();

function record(message: string, detail?: string) {
  useDiagnosticsStore.getState().addIssue('waveform', message, detail);
}

function recordError(message: string, error: unknown) {
  const info = describeError(error);
  record(message, [info.message, info.stack].filter(Boolean).join('\n'));
}

/** One line for the Settings row: what the native layer can do, or why not. */
export async function getModuleInfo(): Promise<string> {
  if (Platform.OS !== 'android') return 'unavailable — Android only';
  const module = await loadNativeAudio();
  const failure = nativeAudioLoadFailure();
  if (!module) return failure ? `unavailable — ${failure}` : 'unavailable';
  try {
    return `MediaCodec — ${module.listDecoders().length} decoders`;
  } catch (error) {
    const info = describeError(error);
    return `unavailable — ${info.message}`;
  }
}

/** Called once on startup: a leftover marker means the last run died natively. */
export async function absorbCrashMarker(): Promise<void> {
  try {
    const pending = await AsyncStorage.getItem(CRASH_KEY);
    if (!pending) return;
    await AsyncStorage.removeItem(CRASH_KEY);
    disabledForSession = true;
    record(
      'Waveform generation closed the app on the previous run, so it is disabled for this session. It turns itself back on next launch.',
    );
  } catch {
    // Storage is best effort.
  }
}

function directory(name: string): Directory {
  const dir = new Directory(Paths.cache, name);
  if (!dir.exists) {
    dir.create({ intermediates: true, idempotent: true });
  }
  return dir;
}

function keyOf(trackId: string): string {
  return stableId('wf', trackId).replace(/[^a-zA-Z0-9]/g, '_');
}

function cacheFile(trackId: string): File {
  return new File(directory(WAVEFORM_DIR), `${keyOf(trackId)}.json`);
}

async function decodeToWav(
  module: NativeAudioModule,
  sourcePath: string,
  wavPath: string,
): Promise<boolean> {
  // Native work cannot be caught from JS; the marker tells the next launch to
  // stand down instead of crashing in a loop.
  await AsyncStorage.setItem(CRASH_KEY, String(Date.now())).catch(() => undefined);

  try {
    await module.decodeToWav(sourcePath, wavPath, SAMPLE_RATE, MAX_SECONDS);
    return true;
  } catch (error) {
    recordError('The device decoder failed to decode this track.', error);
    return false;
  } finally {
    await AsyncStorage.removeItem(CRASH_KEY).catch(() => undefined);
  }
}

async function generate(trackId: string, trackUri: string): Promise<TrackAnalysis | undefined> {
  if (disabledForSession || Platform.OS !== 'android') return undefined;

  const module = await loadNativeAudio();
  if (!module) return undefined;

  const key = keyOf(trackId);
  const wavFile = new File(directory(TEMP_DIR), `${key}.wav`);
  let cleanup: File | undefined;

  try {
    const source = await stageReadableSource({
      uri: trackUri,
      key,
      directory: directory(TEMP_DIR),
    });
    cleanup = source.cleanup;

    if (wavFile.exists) wavFile.delete();
    const decoded = await decodeToWav(module, source.path, toPath(wavFile.uri));
    if (!decoded) return undefined;

    const bytes = await wavFile.bytes();
    const analysis = analyzeWav(bytes, { barCount: BARS, sampleRate: SAMPLE_RATE });
    if (!analysis) {
      record('Decoding produced no audio samples for this track. The file may be DRM-protected.');
      return undefined;
    }

    try {
      await cacheFile(trackId).write(JSON.stringify({ v: CACHE_VERSION, ...analysis }));
    } catch {
      // A cache miss only costs a re-decode.
    }
    return analysis;
  } catch (error) {
    recordError('Audio analysis failed.', error);
    return undefined;
  } finally {
    try {
      if (wavFile.exists) wavFile.delete();
    } catch {
      // Ignore.
    }
    try {
      if (cleanup?.exists) cleanup.delete();
    } catch {
      // Ignore.
    }
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Cached analysis for a track, or undefined when it was never analysed. */
export async function getAnalysis(trackId: string): Promise<TrackAnalysis | undefined> {
  try {
    const file = cacheFile(trackId);
    if (!file.exists) return undefined;
    const parsed = JSON.parse(await file.text()) as {
      v?: number;
      peaks?: unknown;
      rmsDb?: unknown;
      peakDb?: unknown;
      lead?: unknown;
      tail?: unknown;
    };
    // Version 1 caches held peaks only; they are re-decoded on first use so
    // leveling has loudness data to work with.
    if (parsed.v !== CACHE_VERSION || !Array.isArray(parsed.peaks)) return undefined;
    const peaks = parsed.peaks.filter(isFiniteNumber);
    if (peaks.length === 0 || !isFiniteNumber(parsed.rmsDb)) return undefined;

    return {
      peaks,
      rmsDb: parsed.rmsDb,
      peakDb: isFiniteNumber(parsed.peakDb) ? parsed.peakDb : 0,
      lead: isFiniteNumber(parsed.lead) ? parsed.lead : 0,
      tail: isFiniteNumber(parsed.tail) ? parsed.tail : 0,
    };
  } catch {
    return undefined;
  }
}

/** Cached analysis if present, otherwise decode once (concurrent calls share a run). */
export async function loadAnalysis(
  trackId: string,
  trackUri: string,
): Promise<TrackAnalysis | undefined> {
  const cached = await getAnalysis(trackId);
  if (cached) return cached;

  const pending = inflight.get(trackId);
  if (pending) return pending;

  const task = generate(trackId, trackUri).finally(() => inflight.delete(trackId));
  inflight.set(trackId, task);
  return task;
}

/** Cheap cache probe; used to plan an analysis run without decoding. */
export function hasAnalysis(trackId: string): boolean {
  try {
    return cacheFile(trackId).exists;
  } catch {
    return false;
  }
}

/**
 * Deletes cached analysis for tracks that are no longer in the library.
 *
 * @returns How many files were removed.
 */
export async function pruneAnalysis(trackIds: Iterable<string>): Promise<number> {
  try {
    const keep = new Set<string>();
    for (const trackId of trackIds) keep.add(`${keyOf(trackId)}.json`);

    let removed = 0;
    for (const entry of directory(WAVEFORM_DIR).list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.json')) continue;
      if (keep.has(entry.name)) continue;
      try {
        entry.delete();
        removed += 1;
      } catch {
        // Locked or already gone: not worth reporting.
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

export async function deleteWaveform(trackId: string): Promise<void> {
  try {
    const file = cacheFile(trackId);
    if (file.exists) file.delete();
  } catch {
    // Ignore.
  }
}
