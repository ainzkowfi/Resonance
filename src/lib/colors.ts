/**
 * Artwork-derived colours.
 *
 * Pulling the real dominant colour out of an image needs native decoding we
 * do not have, so we derive a stable palette from the artist/album name instead.
 * The ramps are curated from the QuickLiquid reference so every album lands in
 * the same cool, glassy family instead of producing arbitrary muddy hues.
 */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Ramp {
  gradient: [string, string];
  accent: string;
}

const RAMPS: Ramp[] = [
  { gradient: ['#061018', '#0E3550'], accent: '#9AF2FF' },
  { gradient: ['#070B18', '#1D2A7C'], accent: '#6D8BFF' },
  { gradient: ['#0A0714', '#3C1F52'], accent: '#C084FC' },
  { gradient: ['#06110F', '#0F3A2E'], accent: '#7BE5C9' },
  { gradient: ['#120B08', '#4A2417'], accent: '#FF9D7A' },
  { gradient: ['#081018', '#24437A'], accent: '#7DE9FF' },
];

function rampFor(seed: string): Ramp {
  return RAMPS[hash(seed || 'resonance') % RAMPS.length];
}

/** Two-stop subdued gradient for a track, derived from its name. */
export function gradientFor(seed: string): [string, string] {
  return rampFor(seed).gradient;
}

/** Accent colour for a track, used for progress and highlights. */
export function accentFor(seed: string): string {
  return rampFor(seed).accent;
}
