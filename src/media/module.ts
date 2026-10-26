import { requireNativeModule } from 'expo';

import { describeError, useDiagnosticsStore } from '../store/diagnostics';

/**
 * The native codec surface (`src/native/MediaAudioModule.kt`).
 *
 * Everything the analysis pipeline needs: one decode job and the codec
 * inventory for the capability probe.
 */
interface MediaAudioModuleType {
  decodeToWav(
    sourcePath: string,
    outputPath: string,
    targetSampleRate: number,
    maxSeconds: number,
  ): Promise<boolean>;
  listDecoders(): string[];
  listEncoders(): string[];
}

export type NativeAudioModule = MediaAudioModuleType;

let modulePromise: Promise<NativeAudioModule | null> | null = null;
let loadFailure: string | undefined;

/**
 * Loads the native module exactly once, behind a guard.
 *
 * `requireNativeModule` throws when the installed binary does not contain the
 * module (stale dev build, web, Expo Go). Loading lazily inside a try/catch
 * turns that into a recorded problem instead of a crash at startup.
 */
export function loadNativeAudio(): Promise<NativeAudioModule | null> {
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        return requireNativeModule('MediaAudioModule') as NativeAudioModule;
      } catch (error) {
        const info = describeError(error);
        loadFailure = info.message;
        useDiagnosticsStore.getState().addIssue(
          'waveform',
          'The native audio module is not available in this build. Waveforms need a development build that includes MediaAudioModule.',
          [info.message, info.stack].filter(Boolean).join('\n'),
        );
        return null;
      }
    })();
  }
  return modulePromise;
}

/** The load error, when the module could not be loaded. */
export function nativeAudioLoadFailure(): string | undefined {
  return loadFailure;
}
