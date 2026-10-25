import { Directory, File, Paths } from 'expo-file-system';

import { evaluateExportCheck, selfTestWav, type ExportCheckResult } from '../lib/encodeCheck';
import { describeError } from '../store/diagnostics';
import type { FFmpegModule } from './module';
import { toPath } from './paths';

/**
 * Proves the packaged binary can actually produce a playable file.
 *
 * The component listings say AAC and `mp4` exist; this writes a second of known
 * audio as WAV, encodes it, and measures what landed on disk. The command is
 * deliberately the same shape a clip export would use — read a source, encode
 * AAC, mux MP4 — so a pass here is evidence for that feature rather than a toy
 * test. WAV in also keeps the unknowns to the encoder and muxer.
 *
 * Nothing touches the library: both files live in the cache directory and are
 * deleted before returning, whatever the outcome.
 */

export interface SelfTestReport extends ExportCheckResult {
  /** FFmpeg's own output when something failed. */
  detail?: string;
}

const FOLDER = 'ffmpeg-probe';
/** A one-second encode is quick; anything near this is a hung process. */
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

export async function runExportSelfTest(module: FFmpegModule): Promise<SelfTestReport> {
  const folder = probeFolder();
  const source = new File(folder, 'selftest.wav');
  const output = new File(folder, 'selftest.m4a');
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await source.write(selfTestWav());
    if (output.exists) output.delete();

    const session = module.run(
      [
        '-y',
        '-i',
        toPath(source.uri),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-f',
        'mp4',
        toPath(output.uri),
      ],
      { logLevel: 'error' },
    );

    timer = setTimeout(() => {
      void session.cancel();
    }, TIMEOUT_MS);

    const result = await session.result;
    const verdict = evaluateExportCheck({
      returnCode: result.returnCode,
      bytes: sizeOf(output),
      ms: result.duration,
    });

    return verdict.ok
      ? verdict
      : { ...verdict, detail: result.output.trim() || undefined };
  } catch (error) {
    const info = describeError(error);
    return {
      ok: false,
      message: 'The export self-test could not run',
      bytes: 0,
      ms: 0,
      detail: [info.message, info.stack].filter(Boolean).join('\n'),
    };
  } finally {
    if (timer) clearTimeout(timer);
    remove(source);
    remove(output);
  }
}
