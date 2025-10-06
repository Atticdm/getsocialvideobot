import * as path from 'path';
import * as fs from 'fs-extra';
import { detectProvider, getProvider } from '../providers';
import { AppError, ERROR_CODES } from '../core/errors';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { concatenateAudioParts, muxFinalVideo } from '../core/media';
import { run } from '../core/exec';
import { transcribeWithWhisper } from '../services/whisper';
import { translateText } from '../services/translator';
import { synthesizeSpeech } from '../services/tts';
import {
  TranslationDirection,
  TranslationResult,
  TranslationStage,
  WhisperLanguage,
} from '../types/translation';

const ffmpegBinary = process.env['FFMPEG_PATH'] || 'ffmpeg';

type TimelineSegment = { type: 'speech' | 'pause'; start: number; end: number };
type AudioAnalysis = { gender: 'male' | 'female' | 'unknown'; timeline: TimelineSegment[] };

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

function resolveLanguages(direction: TranslationDirection, detected: WhisperLanguage): {
  source: WhisperLanguage;
  target: WhisperLanguage;
} {
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

export interface ReelTranslationOptions {
  direction: TranslationDirection;
}

export async function translateInstagramReel(
  url: string,
  sessionDir: string,
  options: ReelTranslationOptions,
  observer?: (stage: TranslationStage) => void
): Promise<TranslationResult> {
  const stages: TranslationStage[] = [];

  const providerName = detectProvider(url);
  if (providerName !== 'instagram') {
    throw new AppError(
      ERROR_CODES.ERR_TRANSLATION_NOT_SUPPORTED,
      'Only Instagram reels are supported for translation right now',
      { url, provider: providerName }
    );
  }

  const instagram = getProvider('instagram');

  // 1. Скачивание
  const downloadStage = beginStage('download', stages);
  const { filePath: downloadPath, videoInfo } = await instagram.download(url, sessionDir);
  completeStage(downloadStage);
  await notifyObserver(observer, downloadStage);

  // 2. Извлечение полного аудио и анализ (VAD + Gender)
  const analysisStage = beginStage('analyze-audio', stages);
  const fullAudioPath = path.join(sessionDir, `${videoInfo.id}.wav`);
  await run(ffmpegBinary, ['-y', '-i', downloadPath, '-ar', '16000', '-ac', '1', fullAudioPath]);

  const analysisScriptPath = path.join(process.cwd(), 'scripts', 'detect_gender.py');
  const analysisResult = await run('python3', [analysisScriptPath, fullAudioPath]);
  if (analysisResult.code !== 0) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Audio analysis script failed', { stderr: analysisResult.stderr });
  }
  const { gender, timeline } = JSON.parse(analysisResult.stdout || '{}') as AudioAnalysis;
  if (!timeline || timeline.length === 0) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Audio analysis returned empty timeline');
  }
  logger.info('Audio analysis complete', { gender, timelineSegments: timeline.length });
  completeStage(analysisStage);
  await notifyObserver(observer, analysisStage);

  // 3. Транскрипция и перевод
  const transcribeStage = beginStage('transcribe', stages);
  const whisperOutput = await transcribeWithWhisper(fullAudioPath);
  await fs.writeFile(path.join(sessionDir, `${videoInfo.id}.transcript.txt`), whisperOutput.text, 'utf8');
  completeStage(transcribeStage);
  await notifyObserver(observer, transcribeStage);

  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);

  const translateStage = beginStage('translate', stages);
  const translatedText = await translateText(whisperOutput.text, source, target);
  await fs.writeFile(path.join(sessionDir, `${videoInfo.id}.translation.txt`), translatedText, 'utf8');
  completeStage(translateStage);
  await notifyObserver(observer, translateStage);

  // 4. Пропорциональное распределение текста и синтез речи по частям
  const synthStage = beginStage('synthesize', stages);
  const speechSegments = timeline.filter((s) => s.type === 'speech');
  const totalSpeechDuration = speechSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
  let textOffset = 0;
  const audioParts: string[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const segment = timeline[i]!;
    const segmentDuration = Math.max(0.1, segment.end - segment.start);
    const partPath = path.join(sessionDir, `part_${i}.mp3`);

    if (segment.type === 'speech') {
      const proportion = totalSpeechDuration > 0 ? segmentDuration / totalSpeechDuration : 1;
      let textPartLength = Math.round(proportion * translatedText.length);
      if (i === timeline.length - 1 || textOffset + textPartLength > translatedText.length) {
        textPartLength = translatedText.length - textOffset;
      }
      if (textPartLength <= 0 && textOffset < translatedText.length) {
        textPartLength = Math.min(20, translatedText.length - textOffset);
      }

      const textPart = translatedText.substring(textOffset, textOffset + textPartLength);
      textOffset += textPartLength;

      const estimatedCps = textPartLength / segmentDuration;
      const targetCps = 15; // ≈ 3 слова/сек при ~5 символов
      const rawSpeed = estimatedCps > 0 ? estimatedCps / targetCps : 1.0;
      const speed = Math.max(0.75, Math.min(rawSpeed, 1.6));

      const voiceId = selectVoiceId(target, gender);
      await synthesizeSpeech(textPart || '.', partPath, {
        voiceId,
        speed,
        language: target === 'ru' ? 'ru' : 'en',
      });
    } else {
      // Генерируем тишину нужной длительности
      await run(ffmpegBinary, [
        '-y',
        '-f', 'lavfi',
        '-i', 'anullsrc=r=44100:cl=mono',
        '-t', segmentDuration.toFixed(3),
        '-acodec', 'libmp3lame',
        '-q:a', '4',
        partPath,
      ]);
    }
    audioParts.push(partPath);
  }
  completeStage(synthStage);
  await notifyObserver(observer, synthStage);

  // 5. Сборка аудиодорожки и финального видео
  const muxStage = beginStage('mux', stages);
  const finalAudioPath = path.join(sessionDir, 'final_audio.mp3');
  await concatenateAudioParts(audioParts, finalAudioPath);

  const outputVideoPath = path.join(sessionDir, `${videoInfo.id}.final.mp4`);
  await muxFinalVideo(downloadPath, finalAudioPath, outputVideoPath);
  completeStage(muxStage);
  await notifyObserver(observer, muxStage);

  return {
    videoPath: outputVideoPath,
    transcriptPath: path.join(sessionDir, `${videoInfo.id}.transcript.txt`),
    translatedText,
    audioPath: finalAudioPath,
    stages,
  };
}
