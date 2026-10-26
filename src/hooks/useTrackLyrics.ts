import { useEffect, useState } from 'react';

import { readLocalLyrics } from '../library/local';
import { describeError, useDiagnosticsStore } from '../store/diagnostics';
import type { Lyrics, Track } from '../types/track';

/**
 * Lyrics, read once per track and remembered.
 *
 * Only a *finished* read is cached. A failed one is deliberately left out: the
 * folder grant, or the file itself, can arrive a moment after the player first
 * asks. Recording that failure as a result hid the lyrics button for the rest
 * of the session on tracks that do have lyrics, which is why the button looked
 * like it appeared at random.
 */
const lyricsCache = new Map<string, Lyrics | undefined>();

/** Reads in flight, keyed by track, so the player and the track screen share one. */
const reads = new Map<string, Promise<ReadResult>>();

/** Tracks already reported, so one unreadable file leaves one line in the log. */
const reported = new Set<string>();

/** A read that failed on a permission or file-system race is worth another try. */
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 600;

/** `ok: false` means "not read", which is different from "read, nothing there". */
type ReadResult = { ok: true; lyrics: Lyrics | undefined } | { ok: false };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function report(track: Track, error: unknown): void {
  if (reported.has(track.id)) return;
  reported.add(track.id);
  const info = describeError(error);
  useDiagnosticsStore
    .getState()
    .addIssue(
      'lyrics',
      `Could not read lyrics for ${track.title}.`,
      [info.message, info.stack].filter(Boolean).join('\n'),
    );
}

async function attempt(track: Track, remaining: number): Promise<ReadResult> {
  try {
    return { ok: true, lyrics: await readLocalLyrics(track) };
  } catch (error) {
    if (remaining > 0) {
      await wait(RETRY_DELAY_MS);
      return attempt(track, remaining - 1);
    }
    report(track, error);
    return { ok: false };
  }
}

function read(track: Track): Promise<ReadResult> {
  const running = reads.get(track.id);
  if (running) return running;

  const pending = attempt(track, ATTEMPTS - 1).then((result) => {
    reads.delete(track.id);
    // A finished read is remembered even when it found nothing, so a track
    // without lyrics is not looked for again. A failed read is not remembered,
    // so the next look retries instead of answering with the old failure.
    if (result.ok) lyricsCache.set(track.id, result.lyrics);
    return result;
  });

  reads.set(track.id, pending);
  return pending;
}

/** Reads embedded or sidecar lyrics once per track, without network requests. */
export function useTrackLyrics(track: Track | null | undefined) {
  const [settled, setSettled] = useState<{ id: string; lyrics?: Lyrics }>({ id: '' });

  useEffect(() => {
    if (!track || lyricsCache.has(track.id)) return;

    let active = true;
    void read(track).then((result) => {
      // The cache is what the next render reads; this state change exists to
      // make that render happen. It is applied even when the effect was already
      // superseded, because the store can hand the same track back as a new
      // object and the track on screen is the one this answer belongs to.
      if (active && result.ok) setSettled({ id: track.id, lyrics: result.lyrics });
    });

    return () => {
      active = false;
    };
  }, [track]);

  if (!track) return undefined;
  if (lyricsCache.has(track.id)) return lyricsCache.get(track.id);
  return settled.id === track.id ? settled.lyrics : undefined;
}
