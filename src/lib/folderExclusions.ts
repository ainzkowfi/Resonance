/**
 * Folders left out of a library scan.
 *
 * A picked folder is walked recursively, and some trees hold things a music
 * player has no business listing: voice notes, audiobook chapters, a "Sounds"
 * directory full of game assets. Excluding one directory should also exclude
 * everything beneath it, and must not touch a sibling whose name merely starts
 * with the same characters — `Music/Skip` is not `Music/Skipper`.
 *
 * Matching happens on decoded URIs. Android's document provider percent-encodes
 * the path inside the URI, so the picker and the directory listing can disagree
 * on the encoding of the very same folder; decoding both sides first is what
 * makes them comparable. Comparison ignores case because the filesystems these
 * URIs point at do too.
 *
 * Kept pure so the matching rules are covered by `scripts/check.mts`.
 */

/** Percent-decoded, without a trailing slash. */
export function normalizeFolder(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // A URI that cannot be decoded is compared exactly as given.
  }
  return decoded.replace(/\/+$/, '');
}

/** The form two folders are compared in. */
function comparisonKey(uri: string): string {
  return normalizeFolder(uri).toLowerCase();
}

/** Whether a folder — or anything inside it — is excluded from scanning. */
export function isExcluded(uri: string, excluded: readonly string[]): boolean {
  const target = comparisonKey(uri);
  if (!target) return false;
  return excluded.some((folder) => {
    const key = comparisonKey(folder);
    if (!key) return false;
    return target === key || target.startsWith(`${key}/`);
  });
}

/**
 * Adds a folder to the exclusion list.
 *
 * A folder already covered by an exclusion changes nothing, and excluding a
 * parent drops the children it now swallows, so the list stays as short as the
 * user's intent rather than as long as their taps.
 */
export function addExclusion(excluded: readonly string[], uri: string): string[] {
  const folder = normalizeFolder(uri);
  if (!folder) return [...excluded];
  if (isExcluded(folder, excluded)) return [...excluded];

  const kept = excluded.filter((existing) => !isExcluded(existing, [folder]));
  return [...kept, folder];
}

/** Removes exactly one exclusion; its children are not resurrected. */
export function removeExclusion(excluded: readonly string[], uri: string): string[] {
  const key = comparisonKey(uri);
  return excluded.filter((folder) => comparisonKey(folder) !== key);
}

/** The last path segment, which is what a folder is normally called. */
export function folderLabel(uri: string): string {
  const folder = normalizeFolder(uri);
  if (!folder) return uri;
  const parts = folder.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

/** The decoded path, shown under the label so two "Skip" folders differ. */
export function folderPath(uri: string): string {
  const folder = normalizeFolder(uri);
  const scheme = folder.indexOf('://');
  const withoutScheme = scheme >= 0 ? folder.slice(scheme + 3) : folder;
  const authorityEnd = withoutScheme.indexOf('/');
  return authorityEnd >= 0 ? withoutScheme.slice(authorityEnd + 1) : withoutScheme;
}
