/**
 * The native decoder wants plain filesystem paths, not `file://` URIs.
 *
 * Kept in its own module so the analysis pipeline and the decode self-test
 * cannot drift apart on how a cache URI is turned into an argument.
 */
export function toPath(uri: string): string {
  const withoutScheme = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    return withoutScheme;
  }
}
