import { Directory, File } from 'expo-file-system';

import { extensionOf } from '../lib/playbackSupport';
import { toPath } from './paths';

/**
 * A source FFmpeg can open.
 *
 * Files picked through the system folder picker are `content://` URIs (or, on
 * iOS, security-scoped file URLs), and FFmpeg only takes plain paths — so
 * anything that is not `file://` is copied into the caller's cache directory
 * first. Shared by the analysis pipeline and the playback conversion so the two
 * cannot disagree about what FFmpeg is handed.
 */
export interface StagedSource {
  path: string;
  /** The copy to delete afterwards; absent when the original was usable. */
  cleanup?: File;
}

export async function stageReadableSource(options: {
  uri: string;
  /** Unique stem for the staged copy. */
  key: string;
  /** Where the copy goes, normally a cache directory. */
  directory: Directory;
}): Promise<StagedSource> {
  if (options.uri.startsWith('file://')) return { path: toPath(options.uri) };

  const target = new File(options.directory, `${options.key}${extensionOf(options.uri) ?? ''}`);
  if (target.exists) target.delete();
  await new File(options.uri).copy(target);
  return { path: toPath(target.uri), cleanup: target };
}
