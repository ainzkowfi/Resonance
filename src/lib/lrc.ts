/**
 * LRC parsing.
 *
 * LRCLIB returns the classic `[mm:ss.xx]` format. A handful of records also
 * ship the extended `[mm:ss.xx]` + `<mm:ss.xx>` word-sync variant; we only
 * care about line-level timing here.
 */

export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
}

const TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parse an LRC body into time-sorted lines. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    TIME_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = TIME_TAG.exec(raw)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] ? Number(match[3].padEnd(3, '0')) : 0;
      stamps.push(minutes * 60 + seconds + fraction / 1000);
    }
    if (stamps.length === 0) continue;
    TIME_TAG.lastIndex = 0;
    const text = raw.replace(TIME_TAG, '').trim();
    for (const time of stamps) lines.push({ time, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Index of the last line whose timestamp is at or before `position`, or -1. */
export function activeLineIndex(lines: LyricLine[], position: number): number {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].time <= position) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Split plain lyrics into displayable lines, dropping blank ones. */
export function parsePlainLyrics(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
