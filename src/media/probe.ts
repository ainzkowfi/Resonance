import { Platform } from 'react-native';

import { buildCapabilities, formatReport } from '../lib/codecReport';
import { describeError, useDiagnosticsStore, type ProbeReport } from '../store/diagnostics';
import { loadNativeAudio } from './module';
import { runDecodeSelfTest } from './selfTest';

/**
 * Asks the installed build what it can actually decode.
 *
 * The `MediaCodecList` inventory the native module returns is the only
 * trustworthy answer — hardware decoder names vary by vendor, and assuming
 * otherwise is what broke the first waveform attempt. Results are cached in the
 * diagnostics store for the session.
 *
 * A listing is still only a claim about codecs. The probe therefore also runs
 * one real decode of a known WAV, because a decoder being registered does not
 * mean a job will finish.
 */

export type { ProbeReport };

export async function runCapabilityProbe(): Promise<ProbeReport | undefined> {
  const store = useDiagnosticsStore.getState();

  if (Platform.OS === 'web') {
    store.addIssue('probe', 'The capability probe only runs on Android.');
    return undefined;
  }

  const module = await loadNativeAudio();
  if (!module) return undefined;

  try {
    const decoders = module.listDecoders();
    const encoders = module.listEncoders();

    const capabilities = buildCapabilities({ decoders, encoders });

    // The part a listing cannot answer: does a whole job finish?
    const selfTest = await runDecodeSelfTest();

    const device = `${Platform.OS} ${String(Platform.Version)}`;
    const report = formatReport({ device, capabilities, selfTest, decoders, encoders });

    const result: ProbeReport = {
      at: Date.now(),
      version: `${decoders.length} decoders, ${encoders.length} encoders`,
      capabilities,
      selfTest,
      report,
    };
    useDiagnosticsStore.getState().setProbe(result);
    return result;
  } catch (error) {
    const info = describeError(error);
    useDiagnosticsStore
      .getState()
      .addIssue('probe', 'The codec capability probe failed.', [info.message, info.stack].filter(Boolean).join('\n'));
    return undefined;
  }
}
