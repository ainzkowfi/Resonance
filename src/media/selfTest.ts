import { Directory, File, Paths } from 'expo-file-system';

import { evaluateDecodeCheck, selfTestWav, type DecodeCheckResult } from '../lib/decodeCheck';
import { analyzeWav } from '../lib/wav';
import { describeError } from '../store/diagnostics';
import { loadNativeAudio } from './module';
import { toPath } from './paths';

/**
 * Proves the native module can actually decode, all the way to peaks.
 *
 * The decoder listing says which codecs exist; this writes a second of known
 * audio as WAV, runs the exact native job the analysis pipeline uses, and then
 * reads the samples back the way `waveform.ts` does. A pass is evidence for the
 * waveform / leveling / silence pipeline, not just for the codec inventory — a
 * decode that writes a file the analyser cannot read would otherwise pass.
 *
 * Nothing touches the library: both files live in the cache directory and are
 * deleted before returning, whatever the outcome.
 */

export interface SelfTestReport extends DecodeCheckResult {
  /** Why the self-test could not run, when it reached that point. */
  detail?: string;
  /** Waveform columns the decoded audio produced; 0 when there were none. */
  peaks: number;
}

/** Columns asked for: enough to prove the peaks are real data. */
const SELF_TEST_BARS = 32;

const FOLDER = 'codec-probe';
/** A one-second decode is quick; anything near this is a hung codec. */
const TIMEOUT_MS = 15_000;

function probeFolder(): Directory {
  const directory = new Directory(Paths.cache, FOLDER);
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  return directory;
}

function sizeOf(file: File): number {
  try {
    return file.exists ? (file.info().size ?? 0) : 0;
  } catch {
    return 0;
  }
}

function remove(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Best effort: a leftover temp file only costs a little cache.
  }
}

/** The module has no cancel; without this a hung codec would stall the probe forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runDecodeSelfTest(): Promise<SelfTestReport> {
  const module = await loadNativeAudio();
  if (!module) {
    return { ok: false, message: 'The native audio module is missing', bytes: 0, ms: 0, peaks: 0 };
  }

  const folder = probeFolder();
  const source = new File(folder, 'selftest.wav');
  const output = new File(folder, 'selftest-decoded.wav');
  const startedAt = Date.now();

  try {
    await source.write(selfTestWav());
    if (output.exists) output.delete();

    await withTimeout(
      module.decodeToWav(toPath(source.uri), toPath(output.uri), 8_000, 1),
      TIMEOUT_MS,
    );

    const verdict = evaluateDecodeCheck({ bytes: sizeOf(output), ms: Date.now() - startedAt });
    if (!verdict.ok) return { ...verdict, peaks: 0 };

    // The part a byte count cannot answer: are those bytes samples the analyser
    // can use?
    const bytes = await output.bytes();
    const analysis = analyzeWav(bytes, { barCount: SELF_TEST_BARS, sampleRate: 8_000 });
    if (!analysis) {
      return {
        ...verdict,
        ok: false,
        message: 'The decoded file held no usable samples',
        peaks: 0,
      };
    }

    return { ...verdict, peaks: analysis.peaks.length };
  } catch (error) {
    const info = describeError(error);
    return {
      ok: false,
      message: 'The decode self-test could not run',
      bytes: 0,
      ms: Date.now() - startedAt,
      peaks: 0,
      detail: [info.message, info.stack].filter(Boolean).join('\n'),
    };
  } finally {
    remove(source);
    remove(output);
  }
}
