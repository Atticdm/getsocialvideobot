import { promises as fs } from 'fs';
import { run } from './exec';
import { AppError, ERROR_CODES } from './errors';
import { logger } from './logger';

const ffmpegBinary = process.env['FFMPEG_PATH'] || 'ffmpeg';

export async function concatenateAudioParts(partPaths: string[], outputPath: string): Promise<void> {
  const fileList = partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  const concatFilePath = `${outputPath}.txt`;
  await fs.writeFile(concatFilePath, fileList, 'utf8');

  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', concatFilePath, '-c', 'copy', outputPath];
  const result = await run(ffmpegBinary, args, { timeout: 180000 });
  if (result.code !== 0) {
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Failed to concatenate audio parts',
      { stderr: result.stderr }
    );
  }
}

export async function muxFinalVideo(
  originalVideoPath: string,
  finalAudioPath: string,
  outputVideoPath: string
): Promise<string> {
  const args = [
    '-y',
    '-i', originalVideoPath,
    '-i', finalAudioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
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
