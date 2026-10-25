import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { stableId } from '../lib/format';
import { analyzeWav } from '../lib/wav';
import { describeError, useDiagnosticsStore } from '../store/diagnostics';
import { ffmpegLoadFailure, loadFFmpeg, type FFmpegModule } from './module';

/**
 * Per-track audio analysis, computed on device.
 *
 * The first version of this asked FFmpeg for a `showwavespic` PNG. Two things
 * were wrong with that: `ffmpeg-expo` ships an LGPL build whose filter set does
 * not include `showwavespic`, and PNG output only exists on Android — so it
 * failed everywhere. It also crashed the app outright when the native module
 * was missing from the installed build.
 *
 * So we now decode the track to a tiny mono WAV (`-ac 1 -ar 8000`) and derive
 * everything in JS. PCM/WAV are supported on both platforms, and one decode
 * yields all of it: waveform peaks, integrated loudness for leveling, and the
 * near-silence at each end. Every native call stays behind a lazy import, so a
 * build without the module degrades to "no analysis" instead of a crash.
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
const CACHE_VERSION = 3;
const BARS = 512;
const SAMPLE_RATE = 8_000;
/** Only the first 15 minutes are analysed: 14 MB of PCM, enough for any song. */
const MAX_SECONDS = 900;
const TIMEOUT_MS = 30_000;
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

export async function getFFmpegInfo(): Promise<string> {
  if (Platform.OS === 'web') return 'unavailable on web';
  const module = await loadFFmpeg();
  const failure = ffmpegLoadFailure();
  if (!module) return failure ? `unavailable — ${failure}` : 'unavailable';
  try {
    return module.getVersion().version;
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

/** FFmpeg wants a plain filesystem path, not a `file://` URI. */
function toPath(uri: string): string {
  const withoutScheme = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}

function extensionOf(uri: string): string {
  const match = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(uri);
  return match ? `.${match[1].toLowerCase()}` : '';
}

/**
 * FFmpeg can only read real paths. Files picked through the system folder
 * picker are `content://` URIs, so those are staged into the cache first.
 */
async function readableSource(
  trackUri: string,
  key: string,
): Promise<{ path: string; cleanup?: File }> {
  if (trackUri.startsWith('file://')) {
    return { path: toPath(trackUri) };
  }
  const target = new File(directory(TEMP_DIR), `${key}${extensionOf(trackUri)}`);
  if (target.exists) target.delete();
  await new File(trackUri).copy(target);
  return { path: toPath(target.uri), cleanup: target };
}

async function decodeToWav(module: FFmpegModule, sourcePath: string, wavPath: string): Promise<boolean> {
  await AsyncStorage.setItem(CRASH_KEY, String(Date.now())).catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = module.run(
      [
        '-y',
        '-i',
        sourcePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-t',
        String(MAX_SECONDS),
        '-f',
        'wav',
        wavPath,
      ],
      { logLevel: 'error' },
    );

    timer = setTimeout(() => {
      void session.cancel();
    }, TIMEOUT_MS);

    const result = await session.result;
    if (result.returnCode !== 0) {
      record(
        `FFmpeg could not decode this track (exit ${result.returnCode}).`,
        result.output.trim() || undefined,
      );
      return false;
    }
    return true;
  } catch (error) {
    recordError('FFmpeg failed while decoding this track.', error);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    await AsyncStorage.removeItem(CRASH_KEY).catch(() => undefined);
  }
}

async function generate(trackId: string, trackUri: string): Promise<TrackAnalysis | undefined> {
  if (disabledForSession || Platform.OS === 'web') return undefined;

  const module = await loadFFmpeg();
  if (!module) return undefined;

  const key = keyOf(trackId);
  const wavFile = new File(directory(TEMP_DIR), `${key}.wav`);
  let cleanup: File | undefined;

  try {
    const source = await readableSource(trackUri, key);
    cleanup = source.cleanup;

    if (wavFile.exists) wavFile.delete();
    const decoded = await decodeToWav(module, source.path, toPath(wavFile.uri));
    if (!decoded) return undefined;

    const bytes = await wavFile.bytes();
    const analysis = analyzeWav(bytes, { barCount: BARS, sampleRate: SAMPLE_RATE });
    if (!analysis) {
      record('FFmpeg produced no audio samples for this track. The file may be DRM-protected.');
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
