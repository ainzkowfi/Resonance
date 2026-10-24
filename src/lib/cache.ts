import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * TTL cache backed by AsyncStorage.
 *
 * The metadata providers are rate-limited per IP, so re-fetching on every app
 * launch is both slow for the user and rude to the services. Everything we
 * fetch is keyed by its natural identity (`artist|track|duration`) and expires
 * after a week.
 */

const PREFIX = 'resonance:meta:';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry<T> {
  at: number;
  value: T;
}

const memory = new Map<string, Entry<unknown>>();

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const hit = memory.get(key);
  if (hit) return hit.value as T;

  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const entry = JSON.parse(raw) as Entry<T>;
    if (Date.now() - entry.at > DEFAULT_TTL_MS) {
      void AsyncStorage.removeItem(PREFIX + key);
      return undefined;
    }
    memory.set(key, entry);
    return entry.value;
  } catch {
    return undefined;
  }
}

export async function cacheSet<T>(key: string, value: T): Promise<void> {
  const entry: Entry<T> = { at: Date.now(), value };
  memory.set(key, entry);
  try {
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // A failed cache write is not worth surfacing; the data is still in memory.
  }
}

export async function cacheDelete(key: string): Promise<void> {
  memory.delete(key);
  try {
    await AsyncStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

export function clearMetadataCache(): Promise<void> {
  memory.clear();
  return AsyncStorage.getAllKeys()
    .then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith(PREFIX)).map((k) => AsyncStorage.removeItem(k))),
    )
    .then(() => undefined)
    .catch(() => undefined);
}
