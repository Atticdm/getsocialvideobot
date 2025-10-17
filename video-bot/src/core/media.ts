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

export async function mixVoiceWithInstrumental(
  instrumentalPath: string,
  voiceTrackPath: string,
  outputAudioPath: string
): Promise<void> {
  const args = [
    '-y',
    '-i',
    instrumentalPath,
    '-i',
    voiceTrackPath,
    '-filter_complex',
    '[0:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.9[instr];'
      + '[1:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.0[voice];'
      + '[instr][voice]amix=inputs=2:normalize=0:dropout_transition=0[aout]',
    '-map',
    '[aout]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '2',
    outputAudioPath,
  ];

  const result = await run(ffmpegBinary, args, { timeout: 240000 });
  if (result.code !== 0) {
    logger.error('Instrumental/voice mix failed', { stderr: result.stderr });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to mix voice with instrumental track', {
      stderr: result.stderr,
      args,
    });
  }
}

export async function mixVoiceWithBackground(
  backgroundMusicPath: string,
  voiceTrackPath: string,
  outputAudioPath: string
): Promise<void> {
  const runMix = async (args: string[]) => {
    const result = await run(ffmpegBinary, args, { timeout: 240000 });
    if (result.code !== 0) {
      return { ok: false as const, stderr: result.stderr };
    }
    return { ok: true as const };
  };

  const primaryArgs = [
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
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '2',
    outputAudioPath,
  ];

  const primary = await runMix(primaryArgs);
  if (primary.ok) return;

  logger.warn('Primary voice/background mix failed, retrying with fallback filter', {
    stderr: primary.stderr,
  });

  const fallbackArgs = [
    '-y',
    '-i',
    backgroundMusicPath,
    '-i',
    voiceTrackPath,
    '-filter_complex',
    '[0:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.35[minbg];'
    + '[1:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.0[voice];'
    + '[minbg][voice]amix=inputs=2:normalize=0:dropout_transition=0[aout]',
    '-map',
    '[aout]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '2',
    outputAudioPath,
  ];

  const fallback = await runMix(fallbackArgs);
  if (!fallback.ok) {
    logger.error('Voice/background mix failed', { stderr: fallback.stderr });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to mix voice with background music', {
      stderr: fallback.stderr,
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
