import * as path from 'path';
import * as fs from 'fs-extra';
import { getProvider } from '../providers';
import { AppError, ERROR_CODES } from '../core/errors';
import { config } from '../core/config';
import { logger } from '../core/logger';
import {
  concatenateAudioParts,
  extractBackgroundMusic,
  mixVoiceWithBackground,
  muxFinalVideo,
} from '../core/media';
import { run } from '../core/exec';
import { transcribeWithWhisper } from '../services/whisper';
import { translateText } from '../services/translator';
import { synthesizeSpeech } from '../services/tts';
import { paths } from '../core/paths';
import {
  TranslationDirection,
  TranslationEngine,
  TranslationResult,
  TranslationStage,
  WhisperLanguage,
} from '../types/translation';
import type { VideoInfo } from '../providers/types';
import { dubVideoWithElevenLabs } from '../services/elevenlabs';

type TimelineSegment = {
  speaker: string;
  start: number;
  end: number;
  type?: 'speech' | 'silence';
  text?: string;
  emotions?: Array<{ name: string; score: number }>;
};

type AudioAnalysis = {
  speakers: Record<string, { gender: 'male' | 'female' | 'unknown' }>;
  segments: TimelineSegment[];
  duration?: number;
  transcript?: string;
  emotions?: Array<Record<string, unknown>>;
  raw?: unknown;
  error?: string;
};

export interface ReelTranslationOptions {
  direction: TranslationDirection;
  engine: TranslationEngine;
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
    logger.warn(
      {
        stage: stage.name,
        error: error instanceof Error ? error.message : String(error),
      },
      'Stage observer failed'
    );
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

function normalizeSegmentType(segment?: TimelineSegment): string {
  return (segment?.type ?? 'speech').toLowerCase();
}

function isSpeechSegment(segment?: TimelineSegment): boolean {
  const type = normalizeSegmentType(segment);
  return type === 'speech' || type === 'voice';
}

function isPauseSegment(segment?: TimelineSegment): boolean {
  const type = normalizeSegmentType(segment);
  return type === 'pause' || type === 'silence';
}

function segmentDuration(segment: TimelineSegment): number {
  return Math.max(0, (segment.end ?? 0) - (segment.start ?? 0));
}

function pickDominantEmotion(segment: TimelineSegment): { name: string; score?: number } | undefined {
  if (!segment.emotions || segment.emotions.length === 0) return undefined;
  return segment.emotions.reduce<{ name: string; score?: number }>((best, current) => {
    const currentScore =
      typeof current.score === 'number' && Number.isFinite(current.score) ? current.score : Number.NEGATIVE_INFINITY;
    const bestScore =
      typeof best.score === 'number' && Number.isFinite(best.score) ? best.score : Number.NEGATIVE_INFINITY;
    return currentScore > bestScore ? current : best;
  }, segment.emotions[0]!);
}

interface PipelineResult {
  audioPath: string;
  translatedText: string;
  transcriptPath: string;
}

function targetLanguageFromDirection(direction: TranslationDirection): string {
  switch (direction) {
    case 'ru-en':
      return 'en';
    case 'en-ru':
    case 'auto':
    default:
      return 'ru';
  }
}

async function runElevenLabsPipeline(
  downloadPath: string,
  sessionDir: string,
  videoInfo: VideoInfo,
  options: ReelTranslationOptions,
  stages: TranslationStage[],
  observer?: (stage: TranslationStage) => void
): Promise<PipelineResult> {
  const dubStage = beginStage('elevenlabs-dub', stages);
  try {
    const extractedAudioPath = path.join(sessionDir, `${videoInfo.id}.original.wav`);
    await run(config.FFMPEG_PATH, ['-y', '-i', downloadPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', extractedAudioPath]);

    const targetLang = targetLanguageFromDirection(options.direction);
    const dubbedPath = await dubVideoWithElevenLabs(extractedAudioPath, targetLang, 'auto');

    const sessionAudioPath = path.join(sessionDir, `${videoInfo.id}.elevenlabs.mp3`);
    await fs.ensureDir(path.dirname(sessionAudioPath));
    await fs.copy(dubbedPath, sessionAudioPath);
    try {
      await fs.remove(dubbedPath);
    } catch (copyError) {
      logger.warn({ copyError }, 'Failed to remove ElevenLabs temporary file');
    }

    completeStage(dubStage);
    await notifyObserver(observer, dubStage);

    return {
      audioPath: sessionAudioPath,
      translatedText: '',
      transcriptPath: '',
    };
  } catch (error) {
    failStage(dubStage, error);
    await notifyObserver(observer, dubStage);
    const cause = error instanceof AppError ? error : new AppError(ERROR_CODES.ERR_INTERNAL, 'ElevenLabs dubbing failed', { cause: error });
    throw cause;
  }
}

async function runHumePipeline(
  downloadPath: string,
  sessionDir: string,
  videoInfo: VideoInfo,
  options: ReelTranslationOptions,
  stages: TranslationStage[],
  observer?: (stage: TranslationStage) => void
): Promise<PipelineResult> {
  const analysisStage = beginStage('analyze-audio', stages);
  let analysis: AudioAnalysis;
  try {
    const fullAudioPath = paths.session.originalAudio(sessionDir, videoInfo.id);
    await run(config.FFMPEG_PATH, ['-y', '-i', downloadPath, '-ar', '16000', '-ac', '1', fullAudioPath]);

    const analysisResult = await run(config.PYTHON_PATH, [paths.scripts.humeAnalyze, fullAudioPath], {
      timeout: 240000,
    });

    if (analysisResult.stderr) {
      logger.debug('Hume analyzer stderr', { stderrPreview: analysisResult.stderr.slice(0, 2000) });
    }

    const stdoutClean = (analysisResult.stdout || '').trim();
    if (analysisResult.code !== 0 || !stdoutClean) {
      logger.error(
        {
          code: analysisResult.code,
          stderr: analysisResult.stderr,
          stdoutPreview: stdoutClean.slice(0, 400),
        },
        'Hume audio analysis script failed or produced no output'
      );
      throw new Error(`Audio analysis script failed. Stderr: ${analysisResult.stderr}`);
    }

    const parsed = JSON.parse(stdoutClean) as AudioAnalysis;
    if (parsed.error) {
      throw new Error(`Audio analysis script returned an error: ${parsed.error}`);
    }

    const segments = (parsed.segments || []).map((segment) => ({
      ...segment,
      type: segment.type ?? 'speech',
    }));

    if (!segments.length) {
      const fallbackSpeaker = Object.keys(parsed.speakers || {})[0] ?? 'speaker_0';
      segments.push({
        speaker: fallbackSpeaker,
        start: 0,
        end: parsed.duration ?? 0,
        type: 'speech',
      });
    }

    const speakers =
      parsed.speakers && Object.keys(parsed.speakers).length > 0
        ? parsed.speakers
        : { [segments[0]?.speaker ?? 'speaker_0']: { gender: 'unknown' as const } };

    analysis = {
      ...parsed,
      segments,
      speakers,
    };

    logger.info(
      {
        humeAnalysis: {
          duration: analysis.duration,
          speakers: analysis.speakers,
          segmentCount: analysis.segments.length,
          dominantEmotionSample: analysis.emotions?.slice(0, 3),
          rawPreview: analysis.raw ? JSON.stringify(analysis.raw).slice(0, 800) : undefined,
        },
      },
      'Hume audio analysis completed'
    );

    completeStage(analysisStage);
    await notifyObserver(observer, analysisStage);
  } catch (error) {
    logger.error(
      {
        stage: 'analyze-audio',
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : String(error),
      },
      'Reel translation stage failed'
    );
    failStage(analysisStage, error);
    await notifyObserver(observer, analysisStage);
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed during audio analysis stage.', { cause: error });
  }

  const transcribeStage = beginStage('transcribe', stages);
  const whisperOutput = await transcribeWithWhisper(paths.session.originalAudio(sessionDir, videoInfo.id));
  completeStage(transcribeStage);
  await notifyObserver(observer, transcribeStage);

  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);

  const translateStage = beginStage('translate', stages);
  const translatedText = await translateText(whisperOutput.text, source, target);
  completeStage(translateStage);
  await notifyObserver(observer, translateStage);

  const synthStage = beginStage('synthesize', stages);
  const audioParts: string[] = [];
  const synthesisTasks: Array<Promise<void>> = [];

  const speechSegments = analysis.segments.filter((segment) => isSpeechSegment(segment));
  const totalSpeechDuration = speechSegments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
  const totalChars = translatedText.length;
  let remainingChars = totalChars;
  let textOffset = 0;
  let remainingSpeechSegments = speechSegments.length;

  const queueSilence = (duration: number, outputPath: string): Promise<void> => {
    const effectiveDuration = duration > 0.01 ? duration : 0.01;
    return run(config.FFMPEG_PATH, [
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100',
      '-t',
      String(effectiveDuration),
      '-q:a',
      '9',
      outputPath,
    ]).then(() => undefined);
  };

  for (let i = 0; i < analysis.segments.length; i++) {
    const segment = analysis.segments[i];
    const partPath = path.join(sessionDir, `part_${i}.mp3`);
    audioParts.push(partPath);

    if (!segment) {
      logger.warn({ index: i }, 'Timeline segment missing, filling with silence');
      synthesisTasks.push(queueSilence(0.1, partPath));
      continue;
    }

    if (isSpeechSegment(segment)) {
      const durationSeconds = segmentDuration(segment);
      let charCount = 0;

      if (remainingSpeechSegments <= 1) {
        charCount = remainingChars;
      } else if (totalSpeechDuration > 0 && durationSeconds > 0 && totalChars > 0) {
        charCount = Math.round((durationSeconds / totalSpeechDuration) * totalChars);
      } else if (remainingSpeechSegments > 0) {
        charCount = Math.floor(remainingChars / remainingSpeechSegments);
      }

      const minCharsToLeave = Math.max(0, remainingSpeechSegments - 1);
      const maxForThisSegment = Math.max(0, remainingChars - minCharsToLeave);
      if (charCount > maxForThisSegment) {
        charCount = maxForThisSegment;
      }
      if (charCount < 0) {
        charCount = 0;
      }
      if (charCount === 0 && remainingChars > minCharsToLeave && maxForThisSegment > 0) {
        charCount = Math.min(1, maxForThisSegment);
      }

      const nextOffset = textOffset + charCount;
      const rawTextPart = translatedText.slice(textOffset, nextOffset);
      textOffset = nextOffset;
      remainingChars -= charCount;
      remainingSpeechSegments = Math.max(0, remainingSpeechSegments - 1);

      const textForSegment = rawTextPart.trim();
      if (textForSegment.length === 0) {
        logger.debug(
          { index: i, durationSeconds, charCount, reason: 'empty_text' },
          'Speech segment resolved to silence'
        );
        synthesisTasks.push(queueSilence(durationSeconds, partPath));
        continue;
      }

      const estimatedDuration = textForSegment.length / 15;
      const speedRatio = durationSeconds > 0.05 ? estimatedDuration / durationSeconds : 1.0;
      const cappedSpeed = Math.max(0.7, Math.min(speedRatio, 1.8));
      const gender = analysis.speakers[segment.speaker]?.gender || 'unknown';
      const dominantEmotion = pickDominantEmotion(segment);
      const voiceId = selectVoiceId(target, gender);

      logger.debug(
        {
          index: i,
          speaker: segment.speaker,
          durationSeconds,
          charCount,
          textPreview: textForSegment.slice(0, 80),
          speed: cappedSpeed,
          gender,
          emotion: dominantEmotion?.name,
          emotionScore: dominantEmotion?.score,
        },
        'Queueing speech synthesis segment'
      );

      synthesisTasks.push(
        (async () => {
          const ttsOptions: Parameters<typeof synthesizeSpeech>[2] = {
            voiceId,
            speed: cappedSpeed,
            gender,
          };
          if (dominantEmotion?.name) {
            const rawScore = dominantEmotion.score;
            const score =
              typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : 1.0;
            ttsOptions.emotion = { name: dominantEmotion.name, score };
          }
          await synthesizeSpeech(textForSegment, partPath, ttsOptions);
        })()
      );
      continue;
    }

    const pauseDuration = segmentDuration(segment);
    const reason = isPauseSegment(segment) ? 'pause' : 'non_speech';
    logger.debug({ index: i, duration: pauseDuration, reason }, 'Queueing silence segment');
    synthesisTasks.push(queueSilence(pauseDuration, partPath));
  }

  if (remainingChars > 0) {
    logger.warn(
      {
        remainingChars,
        totalChars,
        remainingSpeechSegments,
      },
      'Not all translated text was allocated to segments'
    );
  }

  await Promise.all(synthesisTasks);
  const finalVoiceTrackPath = path.join(sessionDir, 'final_voice_track.mp3');
  const missingParts = audioParts.filter((partPath) => !fs.existsSync(partPath));
  if (missingParts.length > 0) {
    logger.warn({ missingPartsCount: missingParts.length }, 'Some synthesized parts are missing on disk');
  }
  const existingParts = audioParts.filter((partPath) => fs.existsSync(partPath));
  await concatenateAudioParts(existingParts, finalVoiceTrackPath);

  const backgroundMusicPath = path.join(sessionDir, 'background_music.wav');
  await extractBackgroundMusic(downloadPath, backgroundMusicPath);

  const finalAudioPath = path.join(sessionDir, 'final_audio.mp3');
  await mixVoiceWithBackground(backgroundMusicPath, finalVoiceTrackPath, finalAudioPath);
  completeStage(synthStage);
  await notifyObserver(observer, synthStage);

  return {
    audioPath: finalAudioPath,
    translatedText,
    transcriptPath: '',
  };
}

export async function translateInstagramReel(
  url: string,
  sessionDir: string,
  options: ReelTranslationOptions,
  observer?: (stage: TranslationStage) => void
): Promise<TranslationResult> {
  const stages: TranslationStage[] = [];
  const instagram = getProvider('instagram');

  const downloadStage = beginStage('download', stages);
  const { filePath: downloadPath, videoInfo } = await instagram.download(url, sessionDir);
  completeStage(downloadStage);
  await notifyObserver(observer, downloadStage);

  let pipelineResult: PipelineResult;
  if (options.engine === 'elevenlabs') {
    pipelineResult = await runElevenLabsPipeline(downloadPath, sessionDir, videoInfo, options, stages, observer);
  } else {
    pipelineResult = await runHumePipeline(downloadPath, sessionDir, videoInfo, options, stages, observer);
  }

  const muxStage = beginStage('mux', stages);
  const outputVideoPath = paths.session.finalVideo(sessionDir, videoInfo.id);
  await muxFinalVideo(downloadPath, pipelineResult.audioPath, outputVideoPath);
  completeStage(muxStage);
  await notifyObserver(observer, muxStage);

  return {
    videoPath: outputVideoPath,
    translatedText: pipelineResult.translatedText,
    audioPath: pipelineResult.audioPath,
    stages,
    transcriptPath: pipelineResult.transcriptPath,
  };
}
