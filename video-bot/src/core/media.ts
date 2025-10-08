import { run } from './exec';
import { AppError, ERROR_CODES } from './errors';
import { logger } from './logger';
import { config } from './config';

const ffmpegBinary = config.FFMPEG_PATH || 'ffmpeg';

export async function concatenateAudioParts(partPaths: string[], outputPath: string): Promise<void> {
  if (partPaths.length === 0) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'No audio parts to concatenate.');
  }

  const inputs = partPaths.flatMap((p) => ['-i', p]);
  const filterParts = partPaths.map((_, i) => `[${i}:a]`);
  const filterComplex = `${filterParts.join('')}concat=n=${partPaths.length}:v=0:a=1[a]`;

  const args = [
    '-y',
    ...inputs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[a]',
    '-acodec',
    'libmp3lame',
    '-q:a',
    '4',
    outputPath,
  ];

  const result = await run(ffmpegBinary, args, { timeout: 240000 });
  if (result.code !== 0) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to concatenate audio parts with filter_complex', {
      stderr: result.stderr,
      args,
    });
  }
}

export async function muxFinalVideo(
  originalVideoPath: string,
  finalAudioPath: string,
  outputVideoPath: string
): Promise<string> {
  const args = [
    '-y',
    '-i',
    originalVideoPath,
    '-i',
    finalAudioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-shortest',
    outputVideoPath,
  ];
  const result = await run(ffmpegBinary, args, { timeout: 300000 });
  if (result.code !== 0) {
    logger.error('Final video muxing failed', { stderr: result.stderr });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to create final video');
  }
  return outputVideoPath;
}
