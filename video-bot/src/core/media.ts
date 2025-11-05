import { run } from './exec';
import { AppError, ERROR_CODES } from './errors';
import { logger } from './logger';
import { config } from './config';
import * as fs from 'fs-extra';
import * as path from 'path';

const ffmpegBinary = config.FFMPEG_PATH || 'ffmpeg';
const ffprobeBinary = config.FFMPEG_PATH ? config.FFMPEG_PATH.replace(/ffmpeg$/i, 'ffprobe') : 'ffprobe';

export interface PreparedVideoResult {
  filePath: string;
  usedOriginal: boolean;
  sizeBefore: number;
  sizeAfter: number;
}

const MAX_TRANSCODE_TIME_MS = 5 * 60 * 1000;

export async function prepareVideoForDelivery(inputPath: string): Promise<PreparedVideoResult> {
  const sizeBefore = await fs
    .stat(inputPath)
    .then((stats) => stats.size)
    .catch((error) => {
      logger.warn({ error, inputPath }, 'Failed to stat video before preparation');
      return 0;
    });

  const dirname = path.dirname(inputPath);
  const parsed = path.parse(inputPath);
  const outputPath = path.join(dirname, `${parsed.name}.prepared.mp4`);

  const filter = "scale='if(gt(iw,ih),min(iw,1280),-2)':'if(gt(iw,ih),-2,min(ih,1280))',setsar=1";
  const args = [
    '-y',
    '-i',
    inputPath,
    '-vf',
    filter,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath,
  ];

  try {
    const result = await run(ffmpegBinary, args, { timeout: MAX_TRANSCODE_TIME_MS });
    if (result.code !== 0) {
      logger.warn(
        {
          inputPath,
          stderr: result.stderr,
          stdout: result.stdout,
        },
        'FFmpeg preparation failed'
      );
      await fs.remove(outputPath).catch(() => undefined);
      return {
        filePath: inputPath,
        usedOriginal: true,
        sizeBefore,
        sizeAfter: sizeBefore,
      };
    }
  } catch (error) {
    logger.warn({ error, inputPath }, 'FFmpeg preparation threw error');
    await fs.remove(outputPath).catch(() => undefined);
    return {
      filePath: inputPath,
      usedOriginal: true,
      sizeBefore,
      sizeAfter: sizeBefore,
    };
  }

  const outputExists = await fs.pathExists(outputPath);
  if (!outputExists) {
    logger.warn({ inputPath, outputPath }, 'Prepared video output missing, using original');
    return {
      filePath: inputPath,
      usedOriginal: true,
      sizeBefore,
      sizeAfter: sizeBefore,
    };
  }

  const sizeAfter = await fs
    .stat(outputPath)
    .then((stats) => stats.size)
    .catch((error) => {
      logger.warn({ error, outputPath }, 'Failed to stat prepared video');
      return 0;
    });

  const reduced = sizeBefore > 0 ? sizeAfter / sizeBefore : 1;
  const meaningfulReduction = sizeAfter > 0 && (sizeAfter + 200 * 1024 < sizeBefore || reduced < 0.95);

  if (!meaningfulReduction || sizeAfter === 0) {
    logger.debug({ sizeBefore, sizeAfter, inputPath }, 'Prepared video not smaller, keeping original file');
    await fs.remove(outputPath).catch(() => undefined);
    return {
      filePath: inputPath,
      usedOriginal: true,
      sizeBefore,
      sizeAfter: sizeBefore,
    };
  }

  logger.info({ inputPath, outputPath, sizeBefore, sizeAfter }, 'Prepared video for delivery');
  return {
    filePath: outputPath,
    usedOriginal: false,
    sizeBefore,
    sizeAfter,
  };
}

export async function getAudioDuration(path: string): Promise<number> {
  try {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ];

    const result = await run(ffprobeBinary, args, { timeout: 15000 });
    if (result.code !== 0) {
      logger.warn('ffprobe failed to parse duration', { path, stderr: result.stderr, stdout: result.stdout });
      return 0;
    }

    const duration = parseFloat(result.stdout.trim());
    if (!Number.isFinite(duration) || duration < 0) {
      logger.warn('ffprobe returned invalid duration', { path, stdout: result.stdout });
      return 0;
    }
    return duration;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error), path }, 'getAudioDuration failed');
    return 0;
  }
}

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
      + '[1:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=9.0[voice];'
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
    '[0:a]stereotools=mlev=0[bg];'
    + '[1:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=9.0[voice];'
    + '[bg][voice]amix=inputs=2:normalize=0[aout]',
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
    + '[1:a]aresample=async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=9.0[voice];'
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
