/**
 * Waveform column maths.
 *
 * The analysis stores far more peaks than fit on screen (512), so the scrubber
 * can draw one bar every few pixels at any width. Resampling happens at render
 * time and is pure, so the expensive decode never needs repeating for a layout
 * change.
 */

/** One bar every ~3 px reads well above about 70 px of width. */
export const COLUMN_WIDTH = 3;
export const MIN_COLUMNS = 24;
export const MAX_COLUMNS = 240;

/** Bar count for a given pixel width; 0 means "not laid out yet". */
export function columnsForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.floor(width / COLUMN_WIDTH)));
}

/**
 * Reduces stored peaks to exactly `columns` bars by taking the loudest peak in
 * each bucket, so no transient disappears. When there are fewer peaks than
 * columns the values are repeated instead.
 */
export function resamplePeaks(peaks: readonly number[], columns: number): number[] {
  if (!Array.isArray(peaks) || peaks.length === 0 || columns <= 0) return [];

  const out: number[] = [];
  for (let i = 0; i < columns; i++) {
    const from = Math.floor((i * peaks.length) / columns);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / columns));
    let peak = 0;
    for (let j = from; j < to && j < peaks.length; j++) {
      const value = peaks[j];
      if (Number.isFinite(value) && value > peak) peak = value;
    }
    out.push(peak);
  }
  return out;
}
