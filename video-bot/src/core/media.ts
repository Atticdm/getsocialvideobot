import { run } from './exec';
import { AppError, ERROR_CODES } from './errors';
import { logger } from './logger';
import { config } from './config';

const ffmpegBinary = config.FFMPEG_PATH || 'ffmpeg';

export async function concatenateAudioParts(partPaths: string[], outputPath: string): Promise<void> {
  if (partPaths.length === 0) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'No audio parts to concatenate.');
  }

  const args = ['-y'];

  partPaths.forEach((partPath) => {
    args.push('-i', partPath);
  });

  const concatFilterInputs = partPaths.map((_, index) => `[${index}:a]`).join('');
  const filterComplex = `${concatFilterInputs}concat=n=${partPaths.length}:v=0:a=1[a]`;

  args.push(
    '-filter_complex',
    filterComplex,
    '-map',
    '[a]',
    '-acodec',
    'libmp3lame',
    '-q:a',
    '4',
    outputPath
  );

  const result = await run(ffmpegBinary, args, { timeout: 240000 });
  if (result.code !== 0) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to concatenate audio parts with filter_complex', {
      stderr: result.stderr,
      args,
    });
  }
}

export async function extractBackgroundMusic(
  inputVideoPath: string,
  outputMusicPath: string
): Promise<void> {
  const args = [
    '-y',
    '-i',
    inputVideoPath,
    '-vn',
    '-acodec',
    'pcm_s16le',
    outputMusicPath,
  ];

  const result = await run(ffmpegBinary, args, { timeout: 240000 });
  if (result.code !== 0) {
    logger.error('Background music extraction failed', { stderr: result.stderr });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to extract background music track');
  }
}

export async function mixVoiceWithBackground(
  backgroundMusicPath: string,
  voiceTrackPath: string,
  outputAudioPath: string
): Promise<void> {
  const args = [
    '-y',
    '-i',
    backgroundMusicPath,
    '-i',
    voiceTrackPath,
    '-filter_complex',
    '[0:a]stereotools=mlev=0[bg];[bg][1:a]amix=inputs=2:normalize=0[aout]',
    '-map',
    '[aout]',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    outputAudioPath,
  ];

  const result = await run(ffmpegBinary, args, { timeout: 240000 });
  if (result.code !== 0) {
    logger.error('Voice/background mix failed', { stderr: result.stderr });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to mix voice with background music');
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
