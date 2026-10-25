/**
 * FFmpeg capability reporting.
 *
 * The first waveform attempt failed because the plan trusted a README instead
 * of asking the binary. `ffmpeg -filters` / `-encoders` / `-muxers` print what
 * is really compiled in, so the app can check itself and say so.
 *
 * Parsing and formatting live here, free of native imports, so the behaviour is
 * covered by `scripts/check.mts`.
 */

export interface Capability {
  label: string;
  ok: boolean;
  /** What Resonance would use it for. */
  note: string;
}

export interface Listings {
  filters: string;
  encoders: string;
  muxers: string;
  decoders: string;
}

/**
 * Pulls component names out of an FFmpeg listing.
 *
 * Lines look like ` T.. aformat         A->A  Convert…`, ` A.... aac  …` or
 * `  E  mp4  …`: a short column of flags, then whitespace, then the name.
 * Header lines (`Filters:`) have mixed case and are ignored.
 */
export function listNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*[A-Z.]{1,7}\s+(\S+)/.exec(line);
    if (!match) continue;
    names.add(match[1].toLowerCase());
  }
  return names;
}

function has(names: Set<string>, ...candidates: string[]): boolean {
  return candidates.some((name) => names.has(name.toLowerCase()));
}

export function buildCapabilities(listings: Listings): Capability[] {
  const filters = listNames(listings.filters);
  const encoders = listNames(listings.encoders);
  const muxers = listNames(listings.muxers);
  const decoders = listNames(listings.decoders);

  return [
    {
      label: 'Waveform decode (PCM → WAV)',
      ok: has(decoders, 'pcm_s16le', 'pcm_s16be') && has(muxers, 'wav'),
      note: 'Decodes a track to mono WAV for peak analysis',
    },
    {
      label: 'Volume filter',
      ok: has(filters, 'volume'),
      note: 'Per-track gain without re-encoding',
    },
    {
      label: 'Trim filter',
      ok: has(filters, 'atrim', 'trim'),
      note: 'Used by clip export',
    },
    {
      label: 'AAC encoder',
      ok: has(encoders, 'aac'),
      note: 'Clip export, format fallback',
    },
    {
      label: 'MP4 / M4A muxer',
      ok: has(muxers, 'mp4', 'ipod'),
      note: 'Container for exported clips',
    },
    {
      label: 'loudnorm filter',
      ok: has(filters, 'loudnorm'),
      note: 'Not planned — leveling is measured from decoded PCM instead',
    },
    {
      label: 'silenceremove filter',
      ok: has(filters, 'silenceremove'),
      note: 'Not planned — silence bounds come from the peak data instead',
    },
    {
      label: 'showwavespic filter',
      ok: has(filters, 'showwavespic'),
      note: 'Superseded by SVG peaks; absent in the LGPL build',
    },
    {
      label: 'MP3 encoder (libmp3lame)',
      ok: has(encoders, 'libmp3lame'),
      note: 'MP3 export would need a custom build',
    },
  ];
}

const RELEVANT = new RegExp(
  [
    'aac',
    'mp3',
    'opus',
    'vorbis',
    'flac',
    'alac',
    'pcm',
    'wav',
    'mp4',
    'ipod',
    'matroska',
    'webm',
    'wave',
    'loudn',
    'silence',
    'trim',
    'volume',
    'atempo',
    'across',
    'concat',
    'format',
    'scale',
    'drawtext',
    'overlay',
  ].join('|'),
  'i',
);

/** Only the audio-relevant lines, so the shared report stays readable. */
export function condenseListing(output: string, maxLines = 80): string[] {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && RELEVANT.test(line));
  return lines.slice(0, maxLines);
}

export function formatReport(input: {
  version: string;
  device: string;
  capabilities: Capability[];
  listings: Listings;
}): string {
  const parts = [
    'Resonance — FFmpeg capability report',
    `version: ${input.version}`,
    `device: ${input.device}`,
    '',
    ...input.capabilities.map((item) => `[${item.ok ? 'yes' : 'no '}] ${item.label}`),
  ];

  for (const [name, output] of Object.entries(input.listings)) {
    const lines = condenseListing(output);
    if (lines.length === 0) continue;
    parts.push('', `### ${name}`, ...lines);
  }

  return parts.join('\n');
}
