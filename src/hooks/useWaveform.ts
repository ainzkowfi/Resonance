import { useEffect, useState } from 'react';

import { loadWaveform } from '../ffmpeg/waveform';

/**
 * Peaks for a track: cached file if present, otherwise decoded once.
 *
 * Returns `null` while nothing is available, so the scrubber can fall back to
 * its plain line without reserving space for a waveform that may never arrive.
 */
export function useWaveform(trackId?: string, trackUri?: string): number[] | null {
  const [result, setResult] = useState<{ id: string; peaks: number[] } | null>(null);

  useEffect(() => {
    if (!trackId || !trackUri) return;

    let cancelled = false;

    void loadWaveform(trackId, trackUri).then((waveform) => {
      if (!cancelled && waveform) setResult({ id: trackId, peaks: waveform.peaks });
    });

    return () => {
      cancelled = true;
    };
  }, [trackId, trackUri]);

  // Guard against the previous track's peaks flashing up during a switch.
  return result && result.id === trackId ? result.peaks : null;
}
