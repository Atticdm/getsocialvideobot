import { run } from './exec';
import { AppError, ERROR_CODES } from './errors';
import { logger } from './logger';

const ffmpegBinary = process.env['FFMPEG_PATH'] || 'ffmpeg';

export async function extractAudioTrack(
  inputVideoPath: string,
  outputAudioPath: string
): Promise<string> {
  const args = [
    '-y',
    '-i',
    inputVideoPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-sample_fmt',
    's16',
    outputAudioPath,
  ];

  const result = await run(ffmpegBinary, args, { timeout: 120000 });
  if (result.code !== 0) {
    logger.error('Audio extraction failed', {
      inputVideoPath,
      stderr: result.stderr,
    });
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Failed to extract audio track',
      { stderr: result.stderr }
    );
  }

  return outputAudioPath;
}

export async function muxVideoWithAudio(
  inputVideoPath: string,
  inputAudioPath: string,
  outputVideoPath: string
): Promise<string> {
  const args = [
    '-y',
    '-i',
    inputVideoPath,
    '-i',
    inputAudioPath,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-shortest',
    outputVideoPath,
  ];

  const result = await run(ffmpegBinary, args, { timeout: 240000 });
  if (result.code !== 0) {
    logger.error('Muxing audio with video failed', {
      inputVideoPath,
      inputAudioPath,
      stderr: result.stderr,
    });
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Failed to mux audio with video',
      { stderr: result.stderr }
    );
  }

  return outputVideoPath;
}
