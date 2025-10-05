import * as path from 'path';
import * as fs from 'fs-extra';
import { detectProvider, getProvider } from '../providers';
import { AppError, ERROR_CODES } from '../core/errors';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { extractAudioTrack, muxVideoWithAudio } from '../core/media';
import { transcribeWithWhisper } from '../services/whisper';
import { translateText } from '../services/translator';
import { synthesizeSpeech } from '../services/tts';
import {
  TranslationDirection,
  TranslationResult,
  TranslationStage,
  WhisperLanguage,
} from '../types/translation';

function beginStage(name: TranslationStage['name'], stages: TranslationStage[]): TranslationStage {
  const stage: TranslationStage = {
    name,
    startedAt: Date.now(),
  };
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

function resolveLanguages(direction: TranslationDirection, detected: WhisperLanguage): {
  source: WhisperLanguage;
  target: WhisperLanguage;
} {
  if (direction === 'en-ru') {
    return { source: 'en', target: 'ru' };
  }
  if (direction === 'ru-en') {
    return { source: 'ru', target: 'en' };
  }

  // auto mode
  if (detected === 'ru') {
    return { source: 'ru', target: 'en' };
  }
  if (detected === 'en') {
    return { source: 'en', target: 'ru' };
  }

  // default fallback
  return { source: 'unknown', target: 'ru' };
}

export interface ReelTranslationOptions {
  direction: TranslationDirection;
}

export async function translateInstagramReel(
  url: string,
  sessionDir: string,
  options: ReelTranslationOptions,
  observer?: (stage: TranslationStage) => void | Promise<void>
): Promise<TranslationResult> {
  const stages: TranslationStage[] = [];

  const provider = detectProvider(url);
  if (provider !== 'instagram') {
    throw new AppError(
      ERROR_CODES.ERR_TRANSLATION_NOT_SUPPORTED,
      'Only Instagram reels are supported for translation right now',
      { url, provider }
    );
  }

  const instagram = getProvider('instagram');

  const downloadStage = beginStage('download', stages);
  let downloadPath: string | null = null;
  let videoId = 'translated-reel';
  try {
    const downloadResult = await instagram.download(url, sessionDir);
    downloadPath = downloadResult.filePath;
    videoId = downloadResult.videoInfo.id;
    completeStage(downloadStage);
    await notifyObserver(observer, downloadStage);
  } catch (error) {
    failStage(downloadStage, error);
    await notifyObserver(observer, downloadStage);
    throw error;
  }

  if (!downloadPath) {
    throw new AppError(
      ERROR_CODES.ERR_FILE_NOT_FOUND,
      'Downloaded file missing',
      { url }
    );
  }

  const audioStage = beginStage('extract-audio', stages);
  const audioPath = path.join(sessionDir, `${videoId}.wav`);
  try {
    await extractAudioTrack(downloadPath, audioPath);
    completeStage(audioStage);
    await notifyObserver(observer, audioStage);
  } catch (error) {
    failStage(audioStage, error);
    await notifyObserver(observer, audioStage);
    throw error;
  }

  const transcriptPath = path.join(sessionDir, `${videoId}.transcript.txt`);
  const whisperStage = beginStage('transcribe', stages);
  let whisperOutput: Awaited<ReturnType<typeof transcribeWithWhisper>>;
  try {
    whisperOutput = await transcribeWithWhisper(audioPath);
    await fs.writeFile(transcriptPath, whisperOutput.text, 'utf8');
    completeStage(whisperStage);
    await notifyObserver(observer, whisperStage);
  } catch (error) {
    failStage(whisperStage, error);
    await notifyObserver(observer, whisperStage);
    throw error;
  }

  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);

  const translateStage = beginStage('translate', stages);
  let translatedText = '';
  const translationPath = path.join(sessionDir, `${videoId}.translation.txt`);
  try {
    translatedText = await translateText(whisperOutput.text, source, target);
    await fs.writeFile(translationPath, translatedText, 'utf8');
    completeStage(translateStage);
    await notifyObserver(observer, translateStage);
  } catch (error) {
    failStage(translateStage, error);
    await notifyObserver(observer, translateStage);
    throw error;
  }

  const synthStage = beginStage('synthesize', stages);
  const audioFormat = config.HUME_AUDIO_FORMAT || 'wav';
  const dubbedAudioPath = path.join(sessionDir, `${videoId}.dub.${audioFormat}`);
  try {
    await synthesizeSpeech(translatedText, dubbedAudioPath);
    completeStage(synthStage);
    await notifyObserver(observer, synthStage);
  } catch (error) {
    failStage(synthStage, error);
    await notifyObserver(observer, synthStage);
    throw error;
  }

  const muxStage = beginStage('mux', stages);
  const outputVideoPath = path.join(sessionDir, `${videoId}.dub.mp4`);
  try {
    await muxVideoWithAudio(downloadPath, dubbedAudioPath, outputVideoPath);
    completeStage(muxStage);
    await notifyObserver(observer, muxStage);
  } catch (error) {
    failStage(muxStage, error);
    await notifyObserver(observer, muxStage);
    throw error;
  }

  logger.info('Reel translation completed', {
    url,
    outputVideoPath,
    stages,
  });

  return {
    videoPath: outputVideoPath,
    transcriptPath: path.join(sessionDir, `${videoId}.transcript.txt`),
    translatedText,
    audioPath: dubbedAudioPath,
    stages,
  };
}
