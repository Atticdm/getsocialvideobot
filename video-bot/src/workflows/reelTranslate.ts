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
type SpeechUnit = { kind: 'speech'; duration: number; trailingPause: number };
type PauseUnit = { kind: 'pause'; duration: number };
type TimelineUnit = SpeechUnit | PauseUnit;

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
  const analysis = JSON.parse(analysisResult.stdout || '{}') as AudioAnalysis;
  if (!analysis.timeline || analysis.timeline.length === 0) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Audio analysis returned empty timeline');
  }
  logger.info('Audio analysis complete', {
    gender: analysis.gender,
    timelineSegments: analysis.timeline.length,
  });
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
  const units = buildTimelineUnits(analysis.timeline);
  const speechUnits = units.filter((u): u is SpeechUnit => u.kind === 'speech');
  const totalSpeechDuration = speechUnits.reduce((sum, u) => sum + u.duration, 0);

  const words = translatedText.trim().split(/\s+/).filter(Boolean);
  const totalWords = words.length;
  let wordIndex = 0;
  let remainingSpeechUnits = speechUnits.length;
  const audioParts: string[] = [];

  try {
    for (const unit of units) {
      if (unit.kind === 'pause') {
        if (unit.duration > 0.05) {
          const pausePath = path.join(sessionDir, `part_${audioParts.length}.mp3`);
          await run(ffmpegBinary, [
            '-y',
            '-f', 'lavfi',
            '-i', 'anullsrc=r=44100:cl=mono',
            '-t', unit.duration.toFixed(3),
            '-acodec', 'libmp3lame',
            '-q:a', '4',
            pausePath,
          ]);
          audioParts.push(pausePath);
        }
        continue;
      }

      const partPath = path.join(sessionDir, `part_${audioParts.length}.mp3`);
      remainingSpeechUnits--;

      const remainingWords = totalWords - wordIndex;
      let wordCount = remainingSpeechUnits > 0 && totalSpeechDuration > 0
        ? Math.max(1, Math.round((unit.duration / totalSpeechDuration) * totalWords))
        : remainingWords;
      wordCount = Math.min(wordCount, remainingWords);

      const segmentWords = words.slice(wordIndex, wordIndex + wordCount);
      wordIndex += wordCount;
      const textPart = segmentWords.join(' ');

      const estimatedDuration = segmentWords.length > 0 ? segmentWords.length / 3 : 0.6;
      const desiredDuration = Math.max(0.1, unit.duration * 0.95);
      const rawSpeed = estimatedDuration > 0 ? estimatedDuration / desiredDuration : 1.0;
      const speed = Math.max(0.6, Math.min(rawSpeed, 1.8));

      const voiceId = selectVoiceId(target, analysis.gender);
      const description = buildActingInstruction(target, analysis.gender, unit.duration, videoInfo.title);

      await synthesizeSpeech(textPart || '.', partPath, {
        voiceId,
        speed,
        language: target === 'ru' ? 'ru' : 'en',
        description,
        trailingSilence: unit.trailingPause,
      });
      audioParts.push(partPath);
    }

    if (wordIndex < totalWords && audioParts.length > 0) {
      const remainingText = words.slice(wordIndex).join(' ');
      if (remainingText.trim().length > 0) {
        const extraPath = path.join(sessionDir, `part_${audioParts.length}.mp3`);
        await synthesizeSpeech(remainingText, extraPath, {
          voiceId: selectVoiceId(target, analysis.gender),
          language: target === 'ru' ? 'ru' : 'en',
          description: buildActingInstruction(target, analysis.gender, Math.max(0.5, remainingText.split(/\s+/).length / 3), videoInfo.title),
        });
        audioParts.push(extraPath);
      }
    }

    completeStage(synthStage);
    await notifyObserver(observer, synthStage);
  } catch (error) {
    failStage(synthStage, error);
    await notifyObserver(observer, synthStage);
    throw error;
  }

  // Новый этап: сборка аудио из частей
  const assembleStage = beginStage('assemble-audio', stages);
  const finalAudioPath = path.join(sessionDir, 'final_audio.mp3');
  try {
    await concatenateAudioParts(audioParts, finalAudioPath);
    completeStage(assembleStage);
    await notifyObserver(observer, assembleStage);
  } catch (error) {
    failStage(assembleStage, error);
    await notifyObserver(observer, assembleStage);
    throw error;
  }

  // Финальный mux
  const muxStage = beginStage('mux', stages);
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

function buildTimelineUnits(timeline: TimelineSegment[]): TimelineUnit[] {
  const units: TimelineUnit[] = [];
  let i = 0;
  while (i < timeline.length) {
    const segment = timeline[i]!;
    const duration = Math.max(0, segment.end - segment.start);
    if (segment.type === 'speech') {
      let trailingPause = 0;
      let j = i + 1;
      while (j < timeline.length && timeline[j]!.type === 'pause') {
        trailingPause += Math.max(0, timeline[j]!.end - timeline[j]!.start);
        j++;
      }
      units.push({ kind: 'speech', duration: Math.max(0.1, duration), trailingPause });
      i = j;
    } else {
      let totalPause = duration;
      let j = i + 1;
      while (j < timeline.length && timeline[j]!.type === 'pause') {
        totalPause += Math.max(0, timeline[j]!.end - timeline[j]!.start);
        j++;
      }
      units.push({ kind: 'pause', duration: Math.max(0, totalPause) });
      i = j;
    }
  }
  return units;
}

function buildActingInstruction(
  target: WhisperLanguage,
  gender: 'male' | 'female' | 'unknown',
  duration: number,
  title?: string
): string {
  const languageLine = target === 'ru'
    ? 'Говори по-русски, чётко и естественно.'
    : 'Speak in English with a clear, natural delivery.';
  const genderLine = gender === 'male'
    ? target === 'ru' ? 'Используй уверенный мужской тембр.' : 'Use a confident masculine tone.'
    : gender === 'female'
      ? target === 'ru' ? 'Используй тёплый женский тембр.' : 'Use a warm feminine tone.'
      : target === 'ru' ? 'Поддерживай нейтральный, дружелюбный тембр.' : 'Use a neutral, friendly tone.';
  const contextLine = title
    ? `Контекст: ${title}.`
    : 'Это озвучка для короткого ролика в соцсетях.';
  const pacingLine = `Синхронизируйся с длительностью ~${duration.toFixed(1)} секунд, сохраняя энергичное повествование.`;
  return `${languageLine} ${genderLine} ${contextLine} ${pacingLine}`.trim();
}
