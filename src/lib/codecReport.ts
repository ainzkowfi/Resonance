/**
 * Codec capability reporting.
 *
 * The device codec inventory — the `MediaCodecList` names the native module
 * returns — is the only trustworthy answer about what a build can decode.
 * Formatting lives here, free of native imports, so `scripts/check.mts` can
 * exercise it with fake codec names.
 */

export interface Capability {
  label: string;
  ok: boolean;
  /** What Resonance would use it for. */
  note: string;
}

export interface CodecListings {
  decoders: string[];
  encoders: string[];
}

/** Codec coverage has to be matched by fragment: hardware decoder names vary by vendor (`c2.qti.`, `OMX.google.`). */
function matches(names: string[], ...fragments: string[]): boolean {
  return names.some((name) => fragments.some((fragment) => name.toLowerCase().includes(fragment)));
}

export function buildCapabilities(listings: CodecListings): Capability[] {
  const { decoders } = listings;
  return [
    {
      label: 'MP3 decode',
      ok: matches(decoders, 'mp3'),
      note: 'Feeds waveform, leveling and silence analysis',
    },
    {
      label: 'AAC / M4A decode',
      ok: matches(decoders, 'aac'),
      note: 'Feeds waveform, leveling and silence analysis',
    },
    {
      label: 'FLAC decode',
      ok: matches(decoders, 'flac'),
      note: 'Feeds waveform, leveling and silence analysis',
    },
    {
      label: 'Vorbis decode',
      ok: matches(decoders, 'vorbis'),
      note: 'Ogg containers',
    },
    {
      label: 'Opus decode',
      ok: matches(decoders, 'opus'),
      note: 'Ogg containers',
    },
    {
      label: 'PCM / WAV passthrough',
      ok: true,
      note: 'WAV needs no codec; samples are read directly',
    },
  ];
}

export interface SelfTestLine {
  ok: boolean;
  message: string;
}

export function formatReport(input: {
  device: string;
  capabilities: Capability[];
  /** Result of the real decode, when one was run. */
  selfTest?: SelfTestLine;
  decoders: string[];
  encoders: string[];
}): string {
  const parts = [
    'Resonance — codec capability report',
    `device: ${input.device}`,
    `decoders: ${input.decoders.length}, encoders: ${input.encoders.length}`,
    '',
    ...input.capabilities.map((item) => `[${item.ok ? 'yes' : 'no '}] ${item.label}`),
  ];

  if (input.selfTest) {
    parts.push(
      '',
      `decode self-test: ${input.selfTest.ok ? 'passed' : 'failed'} — ${input.selfTest.message}`,
    );
  }

  if (input.decoders.length > 0) {
    parts.push('', '### decoders', ...input.decoders);
  }
  if (input.encoders.length > 0) {
    parts.push('', '### encoders', ...input.encoders);
  }

  return parts.join('\n');
}
