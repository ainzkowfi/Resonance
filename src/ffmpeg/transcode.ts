import { Directory, File, Paths } from 'expo-file-system';

import { stableId } from '../lib/format';
import { transcodeArgs } from '../lib/playbackSupport';
import { loadFFmpeg } from './module';
import { toPath } from './paths';
import { stageReadableSource } from './source';

/**
 * Converts a track the native player cannot open into one it can.
 *
 * The fallback behind the playback notice: an `.ogg` on iOS, or an `.ape` on
 * either platform, is decoded and re-encoded as AAC in an MP4 wrapper, which the
 * system player handles everywhere. Copies are cached per track, so the encode
 * happens once and that track behaves normally afterwards.
 *
 * The command is the same shape a clip export would use, which makes the
 * FFmpeg capability self-test in Settings meaningful evidence for this path too.
 * A copy is a re-encode of a lossy source, so it is only ever produced for
 * files that would otherwise do nothing.
 */

const CACHE_DIR = 'playback-cache';
const TEMP_DIR = 'playback-tmp';
/** A five-minute track encodes in seconds; this only catches a hung process. */
const TIMEOUT_MS = 120_000;
/** Below this, the encode produced no usable audio. */
const MIN_BYTES = 1_024;

export type PlaybackCopy =
  | { ok: true; uri: string; cached: boolean }
  | { ok: false; message: string; detail?: string };

function directory(name: string): Directory {
  const dir = new Directory(Paths.cache, name);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function keyOf(trackId: string): string {
  return stableId('play', trackId).replace(/[^a-zA-Z0-9]/g, '_');
}

/** Where the converted copy of a track lives, whether or not it exists yet. */
export function playbackCopyFile(trackId: string): File {
  return new File(directory(CACHE_DIR), `${keyOf(trackId)}.m4a`);
}

function sizeOf(file: File): number {
  try {
    return file.exists ? (file.info().size ?? 0) : 0;
  } catch {
    return 0;
  }
}

function remove(file: File | undefined): void {
  if (!file) return;
  try {
    if (file.exists) file.delete();
  } catch {
    // A leftover cache file only costs space.
  }
}

/**
 * A playable copy of the track, encoded on first use.
 *
 * Every failure is returned rather than thrown: the caller has a track in the
 * player and needs a sentence to show, not an exception to catch.
 */
export async function playbackCopy(track: { id: string; uri: string }): Promise<PlaybackCopy> {
  const target = playbackCopyFile(track.id);
  if (sizeOf(target) >= MIN_BYTES) return { ok: true, uri: target.uri, cached: true };

  const module = await loadFFmpeg();
  if (!module) {
    return {
      ok: false,
      message: 'FFmpeg is not available in this build, so the file cannot be converted.',
    };
  }

  let staged: Awaited<ReturnType<typeof stageReadableSource>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    staged = await stageReadableSource({
      uri: track.uri,
      key: `${keyOf(track.id)}-src`,
      directory: directory(TEMP_DIR),
    });

    remove(target);
    const session = module.run(
      transcodeArgs({ source: staged.path, output: toPath(target.uri) }),
      { logLevel: 'error' },
    );

    timer = setTimeout(() => {
      void session.cancel();
    }, TIMEOUT_MS);

    const result = await session.result;
    const detail = result.output.trim() || undefined;

    if (result.returnCode !== 0) {
      remove(target);
      return {
        ok: false,
        message: `FFmpeg could not convert this file (exit ${result.returnCode}).`,
        detail,
      };
    }

    const bytes = sizeOf(target);
    if (bytes < MIN_BYTES) {
      remove(target);
      return { ok: false, message: 'FFmpeg reported success but wrote no audio.', detail };
    }

    return { ok: true, uri: target.uri, cached: false };
  } catch (error) {
    remove(target);
    return {
      ok: false,
      message: 'The file could not be converted for playback.',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
    remove(staged?.cleanup);
  }
}

/**
 * Deletes converted copies for tracks that are no longer in the library.
 *
 * Copies are megabytes each, so they are pruned whenever the library is scanned
 * rather than left behind after a file is removed.
 *
 * @returns How many files were removed.
 */
export async function prunePlaybackCopies(trackIds: Iterable<string>): Promise<number> {
  try {
    const keep = new Set<string>();
    for (const id of trackIds) keep.add(`${keyOf(id)}.m4a`);

    let removed = 0;
    for (const entry of directory(CACHE_DIR).list()) {
      if (!(entry instanceof File) || !entry.name.endsWith('.m4a')) continue;
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
