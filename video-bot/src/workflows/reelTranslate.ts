import * as path from 'path';
import { getProvider } from '../providers';
import { AppError, ERROR_CODES } from '../core/errors';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { muxFinalVideo } from '../core/media';
import { run } from '../core/exec';
import { transcribeWithWhisper } from '../services/whisper';
import { translateText } from '../services/translator';
import { synthesizeSpeech } from '../services/tts';
import { TranslationDirection, TranslationResult, TranslationStage, WhisperLanguage } from '../types/translation';

const ffmpegBinary = process.env['FFMPEG_PATH'] || 'ffmpeg';

type TimelineSegment = { speaker: string; start: number; end: number };
type AudioAnalysis = {
  speakers: Record<string, { gender: 'male' | 'female' | 'unknown' }>;
  segments: TimelineSegment[];
  error?: string;
};

export interface ReelTranslationOptions {
  direction: TranslationDirection;
}

function beginStage(name: TranslationStage['name'], stages: TranslationStage[]): TranslationStage {
  const stage: TranslationStage = { name, startedAt: Date.now() };
  stages.push(stage);
  return stage;
}

async function notifyObserver(
  observer: ((stage: TranslationStage) => void | Promise<void>) | undefined,
  stage: TranslationStage
): Promise<void> {
  if (!observer) return;
  try {
    await observer(stage);
  } catch (error) {
    logger.warn('Stage observer failed', {
      stage: stage.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function completeStage(stage: TranslationStage): void {
  stage.completedAt = Date.now();
}

function failStage(stage: TranslationStage, error: unknown): void {
  stage.completedAt = Date.now();
  stage.error = error instanceof Error ? error.message : String(error);
}

function resolveLanguages(
  direction: TranslationDirection,
  detected: WhisperLanguage
): { source: WhisperLanguage; target: WhisperLanguage } {
  if (direction === 'en-ru') return { source: 'en', target: 'ru' };
  if (direction === 'ru-en') return { source: 'ru', target: 'en' };
  if (detected === 'ru') return { source: 'ru', target: 'en' };
  if (detected === 'en') return { source: 'en', target: 'ru' };
  return { source: 'unknown', target: 'ru' };
}

function selectVoiceId(target: WhisperLanguage, gender: 'male' | 'female' | 'unknown'): string {
  const isRussian = target === 'ru';
  if (isRussian) {
    return gender === 'male' ? config.HUME_VOICE_ID_RU_MALE : config.HUME_VOICE_ID_RU_FEMALE;
  }
  return gender === 'male' ? config.HUME_VOICE_ID_EN_MALE : config.HUME_VOICE_ID_EN_FEMALE;
}

export async function translateInstagramReel(
  url: string,
  sessionDir: string,
  options: ReelTranslationOptions,
  observer?: (stage: TranslationStage) => void
): Promise<TranslationResult> {
  const stages: TranslationStage[] = [];
  const instagram = getProvider('instagram');

  logger.info('Starting reel translation workflow', {
    url,
    sessionDir,
    direction: options.direction,
  });

  // 1) Download
  const downloadStage = beginStage('download', stages);
  const { filePath: downloadPath, videoInfo } = await instagram.download(url, sessionDir);
  completeStage(downloadStage);
  await notifyObserver(observer, downloadStage);

  // 2) Analyze audio
  const analysisStage = beginStage('analyze-audio', stages);
  let analysis: AudioAnalysis;
  try {
    const fullAudioPath = path.join(sessionDir, `${videoInfo.id}.wav`);
    logger.info('Running ffmpeg to extract audio', {
      ffmpegBinary,
      source: downloadPath,
      target: fullAudioPath,
    });
    const ffmpegResult = await run(ffmpegBinary, ['-y', '-i', downloadPath, '-ar', '16000', '-ac', '1', fullAudioPath]);
    logger.info('FFmpeg execution finished', {
      code: ffmpegResult.code,
      durationMs: ffmpegResult.durationMs,
      stderrPreview: ffmpegResult.stderr?.slice(0, 800),
    });

    const analysisScriptPath = path.join(process.cwd(), 'scripts', 'analyze_audio.py');
    logger.info('Executing audio analysis script', {
      script: analysisScriptPath,
      audioPath: fullAudioPath,
    });
    const analysisResult = await run('python3', [analysisScriptPath, fullAudioPath], { timeout: 120000 });
    logger.info('Audio analysis script exited', {
      code: analysisResult.code,
      durationMs: analysisResult.durationMs,
      stderrPreview: analysisResult.stderr?.slice(0, 800),
    });

    if (analysisResult.code !== 0) {
      logger.error('Audio analysis script execution failed', {
        code: analysisResult.code,
        stderr: analysisResult.stderr,
        stdout: analysisResult.stdout,
      });
      throw new Error(`Audio analysis script exited with code ${analysisResult.code}. Stderr: ${analysisResult.stderr}`);
    }

    analysis = JSON.parse(analysisResult.stdout || '{}') as AudioAnalysis;
    if (analysis.error) {
      throw new Error(`Audio analysis script returned an error: ${analysis.error}`);
    }

    logger.info('Audio analysis complete', {
      speakers: Object.keys(analysis.speakers).length,
      segments: analysis.segments.length,
    });
    completeStage(analysisStage);
    await notifyObserver(observer, analysisStage);
  } catch (error) {
    logger.error('Audio analysis stage failed', {
      url,
      sessionDir,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    failStage(analysisStage, error);
    await notifyObserver(observer, analysisStage);
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed during audio analysis stage', { cause: error });
  }

  // 3) Transcribe
  const transcribeStage = beginStage('transcribe', stages);
  let whisperOutput: Awaited<ReturnType<typeof transcribeWithWhisper>>;
  try {
    whisperOutput = await transcribeWithWhisper(path.join(sessionDir, `${videoInfo.id}.wav`));
    completeStage(transcribeStage);
    await notifyObserver(observer, transcribeStage);
  } catch (error) {
    failStage(transcribeStage, error);
    await notifyObserver(observer, transcribeStage);
    throw error;
  }

  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);

  // 4) Translate
  const translateStage = beginStage('translate', stages);
  let translatedText = '';
  try {
    logger.info('Sending text to translator', {
      requestedDirection: options.direction,
      sourceLanguage: source,
      targetLanguage: target,
      textLength: whisperOutput.text.length,
    });
    translatedText = await translateText(whisperOutput.text, source, target);
    completeStage(translateStage);
    await notifyObserver(observer, translateStage);
  } catch (error) {
    logger.error('Translation stage failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    failStage(translateStage, error);
    await notifyObserver(observer, translateStage);
    throw error;
  }

  // 5) Synthesize speech
  const synthStage = beginStage('synthesize', stages);
  const mainSpeakerId = analysis.segments[0]?.speaker;
  const gender = mainSpeakerId ? analysis.speakers[mainSpeakerId]?.gender || 'unknown' : 'unknown';
  const voiceId = selectVoiceId(target, gender);
  const dubbedAudioPath = path.join(sessionDir, `${videoInfo.id}.dub.mp3`);
  try {
    logger.info('Synthesizing speech', {
      voiceId,
      gender,
      targetLanguage: target,
      textLength: translatedText.length,
    });
    await synthesizeSpeech(translatedText, dubbedAudioPath, {
      voiceId,
      language: target === 'ru' ? 'ru' : 'en',
      description: `Reel translation ${videoInfo.id}`,
    });
    completeStage(synthStage);
    await notifyObserver(observer, synthStage);
  } catch (error) {
    logger.error('Speech synthesis failed', {
      voiceId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    failStage(synthStage, error);
    await notifyObserver(observer, synthStage);
    throw error;
  }

  // 6) Mux final video
  const muxStage = beginStage('mux', stages);
  const outputVideoPath = path.join(sessionDir, `${videoInfo.id}.final.mp4`);
  try {
    logger.info('Muxing final video', {
      originalVideoPath: downloadPath,
      dubbedAudioPath,
      outputVideoPath,
    });
    await muxFinalVideo(downloadPath, dubbedAudioPath, outputVideoPath);
    completeStage(muxStage);
    await notifyObserver(observer, muxStage);
  } catch (error) {
    logger.error('Mux stage failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    failStage(muxStage, error);
    await notifyObserver(observer, muxStage);
    throw error;
  }

  logger.info('Reel translation workflow completed', {
    url,
    outputVideoPath,
    translatedTextLength: translatedText.length,
  });

  return {
    videoPath: outputVideoPath,
    translatedText,
    audioPath: dubbedAudioPath,
    stages,
    transcriptPath: '',
  };
}
