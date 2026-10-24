/**
 * Artwork-derived colours.
 *
 * Pulling the real dominant colour out of an image needs native decoding we
 * do not have, so we derive a stable hue from the artist/album name instead.
 * Same album always gets the same colour, which is what the eye notices.
 */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Two-stop pastel gradient for a track, derived from its name. */
export function gradientFor(seed: string): [string, string] {
  const h = hash(seed || 'resonance') % 360;
  return [hslToHex(h, 64, 94), hslToHex((h + 38) % 360, 72, 84)];
}

/** Accent colour for a track, used for progress and highlights. */
export function accentFor(seed: string): string {
  const h = hash(seed || 'resonance') % 360;
  return hslToHex(h, 78, 48);
}
