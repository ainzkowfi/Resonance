import { describeError, useDiagnosticsStore } from '../store/diagnostics';

export type FFmpegModule = typeof import('ffmpeg-expo');

let ffmpegPromise: Promise<FFmpegModule | null> | null = null;
let loadFailure: string | undefined;

/**
 * Loads the native module exactly once, behind a guard.
 *
 * `ffmpeg-expo` calls `requireNativeModule` at import time, which throws when
 * the installed binary does not contain it (stale dev client, web, Expo Go).
 * Importing lazily inside a try/catch turns that into a recorded problem
 * instead of a crash at startup.
 */
export function loadFFmpeg(): Promise<FFmpegModule | null> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      try {
        return await import('ffmpeg-expo');
      } catch (error) {
        const info = describeError(error);
        loadFailure = info.message;
        useDiagnosticsStore.getState().addIssue(
          'waveform',
          'FFmpeg is not available in this build. Waveforms need a development build that includes ffmpeg-expo.',
          [info.message, info.stack].filter(Boolean).join('\n'),
        );
        return null;
      }
    })();
  }
  return ffmpegPromise;
}

/** The import error, when the module could not be loaded. */
export function ffmpegLoadFailure(): string | undefined {
  return loadFailure;
}
