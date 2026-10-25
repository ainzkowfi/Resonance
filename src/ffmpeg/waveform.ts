import { Directory, File, Paths } from 'expo-file-system';
import { execute, FFmpegError } from 'ffmpeg-expo';

import { stableId } from '../lib/format';

const WAVEFORM_DIR = 'waveforms';

function getWaveformDirectory(): Directory {
  const directory = new Directory(Paths.cache, WAVEFORM_DIR);
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  return directory;
}

function getWaveformPath(trackId: string): string {
  const directory = getWaveformDirectory();
  const filename = `${stableId('wf:', trackId).replace(/[^a-zA-Z0-9]/g, '_')}.png`;
  return new File(directory, filename).uri;
}

export async function generateWaveform(trackUri: string, trackId: string): Promise<string | undefined> {
  try {
    const outputPath = getWaveformPath(trackId);
    const outputFile = new File(outputPath);
    
    // If waveform already exists, return it
    if (outputFile.exists) {
      return outputPath;
    }

    // Generate waveform image using FFmpeg showwavespic filter
    // Using mono audio, reasonable size for mobile display
    await execute([
      '-i',
      trackUri,
      '-filter_complex',
      'aformat=channel_layouts=mono,showwavespic=s=1024x200:colors=#ffffff:scale=log',
      '-frames:v',
      '1',
      '-y',
      outputPath,
    ]);

    if (outputFile.exists) {
      return outputPath;
    }
    return undefined;
  } catch (error) {
    if (error instanceof FFmpegError) {
      console.warn('[waveform] FFmpeg failed:', error.returnCode, error.output);
    } else {
      console.warn('[waveform] Failed to generate waveform:', error);
    }
    return undefined;
  }
}

export async function getWaveform(trackId: string): Promise<string | undefined> {
  try {
    const outputPath = getWaveformPath(trackId);
    const outputFile = new File(outputPath);
    if (outputFile.exists) {
      return outputPath;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function hasWaveform(trackId: string): Promise<boolean> {
  const waveform = await getWaveform(trackId);
  return waveform !== undefined;
}

export async function deleteWaveform(trackId: string): Promise<void> {
  try {
    const outputPath = getWaveformPath(trackId);
    const outputFile = new File(outputPath);
    if (outputFile.exists) {
      outputFile.delete();
    }
  } catch {
    // Ignore errors
  }
}
