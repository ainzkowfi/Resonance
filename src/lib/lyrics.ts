/**
 * Sidecar matching for downloaded libraries.
 *
 * A downloaded album usually ships the audio plus a `.lrc` next to it and often
 * a `cover.jpg`. `expo-media-library` only indexes audio, so these helpers work
 * on a folder listing we obtain through the Storage Access Framework.
 */

const LYRICS_EXTENSIONS = ['lrc', 'txt'];

const COVER_PRIORITY = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'artwork'];

export function basename(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    decoded = uri;
  }
  const parts = decoded.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? decoded;
  const query = last.indexOf('?');
  return query >= 0 ? last.slice(0, query) : last;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Pick the lyrics sidecar for `audioFilename` out of `files`.
 * `.lrc` wins over `.txt`, and an exact stem match wins over a fuzzy one.
 */
export function findLyricsSidecar(files: string[], audioFilename: string): string | undefined {
  const target = stemOf(basename(audioFilename)).trim().toLowerCase();
  if (!target) return undefined;

  const candidates: { file: string; score: number }[] = [];
  for (const file of files) {
    const name = basename(file);
    const ext = extensionOf(name);
    if (!LYRICS_EXTENSIONS.includes(ext)) continue;

    const stem = stemOf(name).trim().toLowerCase();
    let score: number | undefined;
    if (stem === target) score = 100;
    else if (stem.replace(/\s+/g, '') === target.replace(/\s+/g, '')) score = 80;
    else if (stem.endsWith(target) || target.endsWith(stem)) score = 60;
    if (score === undefined) continue;

    // Prefer timed lyrics, and prefer the same case so the name reads sanely.
    candidates.push({ file, score: score + (ext === 'lrc' ? 10 : 0) });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.file;
}

/** `cover.jpg`, `folder.jpg`, `front.png` — the usual album-folder convention. */
export function findCoverSidecar(files: string[]): string | undefined {
  let best: { file: string; rank: number } | undefined;
  for (const file of files) {
    const name = basename(file);
    const ext = extensionOf(name);
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) continue;
    const rank = COVER_PRIORITY.indexOf(stemOf(name).toLowerCase());
    if (rank < 0) continue;
    if (!best || rank < best.rank) best = { file, rank };
  }
  return best?.file;
}

/** Loose `.lrc` sniff for when the extension was stripped by a provider. */
export function looksLikeLrc(text: string): boolean {
  return /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/.test(text);
}
