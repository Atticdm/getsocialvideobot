import { run } from './exec';
import { AppError, ERROR_CODES } from './errors';
import { logger } from './logger';
import * as path from 'path';

const ffmpegBinary = process.env['FFMPEG_PATH'] || 'ffmpeg';
const ffprobeBinary = (process.env['FFMPEG_PATH'] || 'ffmpeg').replace(/ffmpeg$/, 'ffprobe');

export async function getVideoDuration(filePath: string): Promise<number> {
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
  const result = await run(ffprobeBinary, args, { timeout: 30000 });
  if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
  return parseFloat(result.stdout.trim());
}

export async function extractAudioSnippet(inputVideoPath: string, outputAudioPath: string, duration = 3): Promise<void> {
  const args = ['-y', '-i', inputVideoPath, '-t', String(duration), '-ac', '1', '-ar', '16000', outputAudioPath];
  const result = await run(ffmpegBinary, args, { timeout: 30000 });
  if (result.code !== 0) throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to extract audio snippet');
}

export async function detectVoiceGender(audioSnippetPath: string): Promise<'male' | 'female' | 'unknown'> {
  const scriptPath = path.join(process.cwd(), 'scripts', 'detect_gender.py');
  const result = await run('python3', [scriptPath, audioSnippetPath], { timeout: 15000 });
  if (result.code !== 0) {
    logger.warn('Gender detection script failed', { stderr: result.stderr });
    return 'unknown';
  }
  const gender = result.stdout.trim();
  if (gender === 'male' || gender === 'female') return gender;
  return 'unknown';
}

export async function extractFullAudio(inputVideoPath: string, outputAudioPath: string): Promise<string> {
  const args = ['-y', '-i', inputVideoPath, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', outputAudioPath];
  const result = await run(ffmpegBinary, args, { timeout: 120000 });
  if (result.code !== 0) throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to extract full audio');
  return outputAudioPath;
}

export async function processAndMuxVideo(
  originalVideoPath: string,
  newVoiceAudioPath: string,
  outputVideoPath: string
): Promise<string> {
  const args = [
    '-y',
    '-i', originalVideoPath,
    '-i', newVoiceAudioPath,
    '-filter_complex', '[0:a]stereotools=mlev=0[bg];[bg][1:a]amix=inputs=2:duration=shortest:normalize=0[a]',
    '-map', '0:v:0',
    '-map', '[a]',
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
