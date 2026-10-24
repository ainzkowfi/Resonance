/**
 * A tiny HTTP layer shared by every metadata provider.
 *
 * Why it exists: the free APIs we use are rate-limited per IP, and mobile users
 * share carrier NAT addresses. One greedy client can burn a shared quota, so
 * every request goes through a named serial queue with a minimum spacing, and
 * retries honour `Retry-After` instead of hammering.
 */

export const USER_AGENT = 'Resonance/1.0 (+https://github.com/resonance-app)';

/** A named serial queue: one request at a time, spaced by `minGapMs`. */
class RequestQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly minGapMs: number,
    private readonly name: string,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return task();
    });
    // Keep the chain alive even when a task rejects.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** MusicBrainz asks for <= 1 request/second and enforces a User-Agent. */
export const musicBrainzQueue = new RequestQueue(1050, 'musicbrainz');
/** LRCLIB asks for 200-500ms between calls, especially for library scans. */
export const lrclibQueue = new RequestQueue(350, 'lrclib');
/** iTunes allows ~20 calls/min; space them out. */
export const itunesQueue = new RequestQueue(120, 'itunes');
/** Deezer allows 50 req / 5s. */
export const deezerQueue = new RequestQueue(120, 'deezer');

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Skip the provider queue (used by the queue's own internals). */
  signal?: AbortSignal;
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 8000, retries = 1, headers = {} } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        signal: options.signal ?? controller.signal,
      });

      if (!res.ok) {
        if (res.status === 404) throw new HttpError(404, 'not found');
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('Retry-After'));
          if (attempt < retries) {
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * (attempt + 1));
            continue;
          }
        }
        throw new HttpError(res.status, `HTTP ${res.status}`);
      }

      const text = await res.text();
      // Several of these APIs answer errors with a text/plain body.
      if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
        throw new HttpError(res.status, 'unexpected response body');
      }
      return JSON.parse(text) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status === 404) throw err;
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('request failed');
}

/** Run promises concurrently but never fail the whole batch. */
type Settled<T extends readonly Promise<unknown>[]> = {
  -readonly [K in keyof T]: Awaited<T[K]> | undefined;
};

export async function settle<T extends readonly Promise<unknown>[]>(
  tasks: T,
): Promise<Settled<T>> {
  return Promise.all(tasks.map((p) => p.catch(() => undefined))) as Promise<Settled<T>>;
}
