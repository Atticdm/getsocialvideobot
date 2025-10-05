import { run } from './exec';
import { AppError, ERROR_CODES } from './errors';
import { logger } from './logger';

const ffmpegBinary = process.env['FFMPEG_PATH'] || 'ffmpeg';
const ffprobeBinary = (process.env['FFMPEG_PATH'] || 'ffmpeg').replace(/ffmpeg$/, 'ffprobe');

export async function getVideoDuration(filePath: string): Promise<number> {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  try {
    const result = await run(ffprobeBinary, args, { timeout: 30000 });
    if (result.code !== 0) {
      throw new Error(`ffprobe failed with code ${result.code}: ${result.stderr}`);
    }
    const duration = parseFloat(result.stdout.trim());
    if (isNaN(duration)) {
      throw new Error('Could not parse video duration.');
    }
    return duration;
  } catch (error) {
    logger.error('Failed to get video duration', { filePath, error });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Could not determine video duration', { cause: error });
  }
}

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
    inputVideoPath,   // Входной файл 0 (видео + старое аудио)
    '-i',
    inputAudioPath,     // Входной файл 1 (новое аудио)
    '-map', '0:v:0',    // Взять видео из файла 0
    '-map', '1:a:0',    // Взять аудио из файла 1
    '-c:v',
    'copy',             // Копировать видеопоток без перекодирования
    '-c:a',
    'aac',              // Перекодировать новое аудио в AAC
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
