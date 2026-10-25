import { Platform } from 'react-native';

import { buildCapabilities, formatReport } from '../lib/ffmpegReport';
import { describeError, useDiagnosticsStore, type ProbeReport } from '../store/diagnostics';
import { loadFFmpeg, type FFmpegModule } from './module';

/**
 * Asks the installed binary what it can actually do.
 *
 * `ffmpeg -filters`, `-encoders`, `-muxers` and `-decoders` print the compiled-in
 * component list, which is the only trustworthy answer: the packaged build is
 * an LGPL subset, and assuming otherwise is what broke the first waveform
 * attempt. Results are cached in the diagnostics store for the session.
 */

export type { ProbeReport };

const TIMEOUT_MS = 15_000;

const LISTINGS = [
  ['filters', ['-hide_banner', '-filters']],
  ['encoders', ['-hide_banner', '-encoders']],
  ['muxers', ['-hide_banner', '-muxers']],
  ['decoders', ['-hide_banner', '-decoders']],
] as const;

async function collect(module: FFmpegModule, args: string[]): Promise<string> {
  const session = module.run(args, { logLevel: 'info' });
  const timer = setTimeout(() => {
    void session.cancel();
  }, TIMEOUT_MS);

  try {
    const result = await session.result;
    return result.output;
  } finally {
    clearTimeout(timer);
  }
}

export async function runCapabilityProbe(): Promise<ProbeReport | undefined> {
  const store = useDiagnosticsStore.getState();

  if (Platform.OS === 'web') {
    store.addIssue('probe', 'The capability probe only runs on Android and iOS.');
    return undefined;
  }

  const module = await loadFFmpeg();
  if (!module) return undefined;

  try {
    // Sequential on purpose: one native process at a time.
    const listings: Record<string, string> = {};
    for (const [name, args] of LISTINGS) {
      listings[name] = await collect(module, [...args]);
    }

    let version = 'unknown';
    try {
      version = module.getVersion().version;
    } catch {
      // The listings are still useful without a version string.
    }

    const capabilities = buildCapabilities({
      filters: listings.filters ?? '',
      encoders: listings.encoders ?? '',
      muxers: listings.muxers ?? '',
      decoders: listings.decoders ?? '',
    });

    const report = formatReport({
      version,
      device: `${Platform.OS} ${String(Platform.Version)}`,
      capabilities,
      listings: {
        filters: listings.filters ?? '',
        encoders: listings.encoders ?? '',
        muxers: listings.muxers ?? '',
        decoders: listings.decoders ?? '',
      },
    });

    const result: ProbeReport = { at: Date.now(), version, capabilities, report };
    useDiagnosticsStore.getState().setProbe(result);
    return result;
  } catch (error) {
    const info = describeError(error);
    useDiagnosticsStore
      .getState()
      .addIssue('probe', 'The FFmpeg capability probe failed.', [info.message, info.stack].filter(Boolean).join('\n'));
    return undefined;
  }
}
