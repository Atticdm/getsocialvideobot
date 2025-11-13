import * as path from 'path';
import * as fs from 'fs-extra';
import { getProvider } from '../providers';
import { AppError, ERROR_CODES } from '../core/errors';
import { config } from '../core/config';
import { logger } from '../core/logger';
import {
  concatenateAudioParts,
  extractBackgroundMusic,
  getAudioDuration,
  mixVoiceWithBackground,
  mixVoiceWithInstrumental,
  muxFinalVideo,
} from '../core/media';
import { run } from '../core/exec';
import { transcribeWithWhisper } from '../services/whisper';
import { translateText } from '../services/translator';
// import { synthesizeSpeech } from '../services/tts'; // Используется только в закомментированной функции runHumePipeline
import { paths } from '../core/paths';
import { separateAudioWithLalal } from '../services/lalal';
import {
  TranslationDirection,
  TranslationOptions,
  TranslationResult,
  TranslationStage,
  WhisperLanguage,
  WhisperOutput,
} from '../types/translation';
import type { VideoInfo } from '../providers/types';
import { dubVideoWithElevenLabs, getVoiceIdForPreset, synthesizeWithElevenLabsTTS } from '../services/elevenlabs';

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

function beginStage(
  name: TranslationStage['name'],
  stages: TranslationStage[],
  meta?: Record<string, unknown>
): TranslationStage {
  const stage: TranslationStage = { name, startedAt: Date.now() };
  if (meta) stage.meta = meta;
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
  if (direction === 'identity-ru') return { source: 'ru', target: 'ru' };
  if (direction === 'identity-en') return { source: 'en', target: 'en' };
  if (detected === 'ru') return { source: 'ru', target: 'en' };
  if (detected === 'en') return { source: 'en', target: 'ru' };
  return { source: 'unknown', target: 'ru' };
}

// Используется только в закомментированной функции runHumePipeline
// function selectVoiceId(target: WhisperLanguage, gender: 'male' | 'female' | 'unknown'): string {
//   const isRussian = target === 'ru';
//   if (isRussian) {
//     return gender === 'male' ? config.HUME_VOICE_ID_RU_MALE : config.HUME_VOICE_ID_RU_FEMALE;
//   }
//   return gender === 'male' ? config.HUME_VOICE_ID_EN_MALE : config.HUME_VOICE_ID_EN_FEMALE;
// }

function normalizeSegmentType(segment?: TimelineSegment): string {
  return (segment?.type ?? 'speech').toLowerCase();
}

function isSpeechSegment(segment?: TimelineSegment): boolean {
  const type = normalizeSegmentType(segment);
  return type === 'speech' || type === 'voice';
}

// Используется только в закомментированной функции runHumePipeline
// function isPauseSegment(segment?: TimelineSegment): boolean {
//   const type = normalizeSegmentType(segment);
//   return type === 'pause' || type === 'silence';
// }

function segmentDuration(segment: TimelineSegment): number {
  return Math.max(0, (segment.end ?? 0) - (segment.start ?? 0));
}

// Используется только в закомментированной функции runHumePipeline
// function pickDominantEmotion(segment: TimelineSegment): { name: string; score?: number } | undefined {
//   if (!segment.emotions || segment.emotions.length === 0) return undefined;
//   return segment.emotions.reduce<{ name: string; score?: number }>((best, current) => {
//     const currentScore =
//       typeof current.score === 'number' && Number.isFinite(current.score) ? current.score : Number.NEGATIVE_INFINITY;
//     const bestScore =
//       typeof best.score === 'number' && Number.isFinite(best.score) ? best.score : Number.NEGATIVE_INFINITY;
//     return currentScore > bestScore ? current : best;
//   }, segment.emotions[0]!);
// }

interface PipelineResult {
  audioPath: string;
  translatedText: string;
  transcriptPath: string;
}

function targetLanguageFromDirection(direction: TranslationDirection): string {
  switch (direction) {
    case 'identity-ru':
      return 'ru';
    case 'identity-en':
      return 'en';
    case 'ru-en':
      return 'en';
    case 'en-ru':
    case 'auto':
    default:
      return 'ru';
  }
}

function sourceLanguageFromDirection(direction: TranslationDirection): string | undefined {
  switch (direction) {
    case 'identity-ru':
      return 'ru';
    case 'identity-en':
      return 'en';
    case 'ru-en':
      return 'ru';
    case 'en-ru':
      return 'en';
    default:
      return undefined;
  }
}

async function runElevenLabsPipeline(
  originalAudioPath: string,
  sessionDir: string,
  videoInfo: VideoInfo,
  options: TranslationOptions,
  stages: TranslationStage[],
  observer?: (stage: TranslationStage) => void,
  voiceIdOverride?: string
): Promise<PipelineResult> {
  const dubStage = beginStage('elevenlabs-dub', stages);
  try {
    const targetLang = targetLanguageFromDirection(options.direction);
    const sourceLang = sourceLanguageFromDirection(options.direction);
    const dubbedPath = await dubVideoWithElevenLabs(originalAudioPath, targetLang, sourceLang, voiceIdOverride);

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

interface PreparedSpeechData {
  analysis?: AudioAnalysis;
  speechSegments: TimelineSegment[];
  translatedText: string;
  targetLanguage: WhisperLanguage;
}

type WhisperSegment = NonNullable<WhisperOutput['segments']>[number];

function convertWhisperSegments(segments: WhisperOutput['segments'] | undefined): TimelineSegment[] {
  if (!segments || segments.length === 0) {
    return [
      {
        speaker: 'speaker_0',
        start: 0,
        end: 1,
        type: 'speech',
        text: '',
      },
    ];
  }

  const actualSegments = segments as WhisperSegment[];

  return actualSegments.map((segment: WhisperSegment, index: number) => {
    const start = Math.max(0, Number(segment?.start ?? 0));
    const rawEnd = Number(segment?.end ?? start + 0.5);
    const end = Number.isFinite(rawEnd) ? Math.max(start + 0.05, rawEnd) : start + 0.5;
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    return {
      speaker: `speaker_${segment?.id ?? index}`,
      start,
      end,
      type: 'speech' as const,
      text,
    };
  });
}

const MIN_TTS_SEGMENT_DURATION = 0.5;
const MIN_TTS_SEGMENT_CHARS = 20;

function mergeSmallSegments(segments: TimelineSegment[]): TimelineSegment[] {
  if (segments.length <= 1) return segments.map((segment) => ({ ...segment }));

  const merged: TimelineSegment[] = [];
  let buffer: TimelineSegment | null = null;

  const pushBuffer = () => {
    if (buffer) {
      buffer.text = (buffer.text ?? '').trim();
      merged.push(buffer);
      buffer = null;
    }
  };

  for (const segment of segments) {
    const normalizedText = (segment.text ?? '').trim();
    const normalized: TimelineSegment = { ...segment, text: normalizedText };
    const segmentDurationSeconds = segmentDuration(normalized);
    const currentIsSmall =
      segmentDurationSeconds < MIN_TTS_SEGMENT_DURATION || normalizedText.length < MIN_TTS_SEGMENT_CHARS;

    if (!buffer) {
      buffer = { ...normalized };
      if (!currentIsSmall) {
        pushBuffer();
      }
      continue;
    }

    const bufferDuration = segmentDuration(buffer);
    const bufferText = (buffer.text ?? '').trim();
    const bufferIsSmall = bufferDuration < MIN_TTS_SEGMENT_DURATION || bufferText.length < MIN_TTS_SEGMENT_CHARS;

    if (bufferIsSmall || currentIsSmall) {
      buffer.end = normalized.end;
      buffer.text = `${bufferText} ${normalizedText}`.trim();
      continue;
    }

    pushBuffer();
    buffer = { ...normalized };
    if (!currentIsSmall) {
      pushBuffer();
    }
  }

  pushBuffer();
  return merged.filter((segment) => (segment.text ?? '').length > 0 || segmentDuration(segment) > 0.05);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareSpeechData(
  originalAudioPath: string,
  options: TranslationOptions,
  stages: TranslationStage[],
  observer?: (stage: TranslationStage) => void,
  vocalPath?: string
): Promise<PreparedSpeechData> {
  const transcriptionSource = vocalPath || originalAudioPath;

  if (options.mode === 'voice') {
    const transcribeStage = beginStage('transcribe', stages);
    const whisperOutput = await transcribeWithWhisper(transcriptionSource);
    completeStage(transcribeStage);
    await notifyObserver(observer, transcribeStage);

    const { source, target } = resolveLanguages(options.direction, whisperOutput.language);
    const isIdentityDirection = options.direction === 'identity-ru' || options.direction === 'identity-en';
    const shouldTranslate = !isIdentityDirection;

    let translatedText = whisperOutput.text;
    if (shouldTranslate) {
      const translateStage = beginStage('translate', stages);
      translatedText = await translateText(whisperOutput.text, source, target);
      completeStage(translateStage);
      await notifyObserver(observer, translateStage);
    }

    const rawSegments = convertWhisperSegments(whisperOutput.segments);
    const speechSegments = mergeSmallSegments(rawSegments);

    return {
      speechSegments,
      translatedText,
      targetLanguage: target,
    };
  }

  const analysisStage = beginStage('analyze-audio', stages);
  let analysis: AudioAnalysis;
  try {
    const analysisSource = transcriptionSource;
    const analysisResult = await run(config.PYTHON_PATH, [paths.scripts.humeAnalyze, analysisSource], {
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
  const whisperOutput = await transcribeWithWhisper(transcriptionSource);
  completeStage(transcribeStage);
  await notifyObserver(observer, transcribeStage);

  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);

  let translatedText = whisperOutput.text;
  if (options.mode !== 'dubbing') {
    const translateStage = beginStage('translate', stages);
    translatedText = await translateText(whisperOutput.text, source, target);
    completeStage(translateStage);
    await notifyObserver(observer, translateStage);
  }

  const speechSegments = analysis.segments.filter((segment) => isSpeechSegment(segment));

  return {
    analysis,
    speechSegments,
    translatedText,
    targetLanguage: target,
  };
}

// Hume функционал временно отключен
/*
async function runHumePipeline(
  downloadPath: string,
  originalAudioPath: string,
  sessionDir: string,
  options: TranslationOptions,
  stages: TranslationStage[],
  observer?: (stage: TranslationStage) => void,
  vocalPath?: string,
  instrumentalPath?: string
): Promise<PipelineResult> {
  const { analysis, speechSegments, translatedText, targetLanguage } = await prepareSpeechData(
    originalAudioPath,
    options,
    stages,
    observer,
    vocalPath
  );

  if (!analysis) {
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Hume analysis data missing', {
      mode: options.mode,
    });
  }

  const synthStage = beginStage('synthesize', stages);
  const audioParts: string[] = [];
  const synthesisTasks: Array<Promise<void>> = [];

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
      const voiceId = selectVoiceId(targetLanguage === 'unknown' ? 'ru' : targetLanguage, gender);

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

  const finalAudioPath = path.join(sessionDir, 'final_audio.mp3');
  const mixInstrumental = instrumentalPath;
  if (!mixInstrumental) {
    logger.warn(
      { sessionDir },
      'Instrumental track missing, falling back to original background extraction'
    );
    const backgroundMusicPath = path.join(sessionDir, 'background_music.wav');
    await extractBackgroundMusic(downloadPath, backgroundMusicPath);
    await mixVoiceWithBackground(backgroundMusicPath, finalVoiceTrackPath, finalAudioPath);
  } else {
    await mixVoiceWithInstrumental(mixInstrumental, finalVoiceTrackPath, finalAudioPath);
  }
  completeStage(synthStage);
  await notifyObserver(observer, synthStage);

  return {
    audioPath: finalAudioPath,
    translatedText,
    transcriptPath: '',
  };
}
*/

async function runElevenLabsTtsPipeline(
  downloadPath: string,
  originalAudioPath: string,
  sessionDir: string,
  options: TranslationOptions,
  stages: TranslationStage[],
  observer: ((stage: TranslationStage) => void | Promise<void>) | undefined,
  vocalPath: string | undefined,
  instrumentalPath: string | undefined,
  voiceId: string
): Promise<PipelineResult> {
  const { speechSegments, translatedText } = await prepareSpeechData(
    originalAudioPath,
    options,
    stages,
    observer,
    vocalPath
  );

  const mergedSegments = mergeSmallSegments(speechSegments);

  const ttsQueueStage = beginStage('tts-queue', stages, { requests: mergedSegments.length });
  completeStage(ttsQueueStage);
  await notifyObserver(observer, ttsQueueStage);

  const synthStage = beginStage('synthesize', stages);
  const audioParts: string[] = [];
  const totalSpeechDuration = mergedSegments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
  const totalChars = translatedText.length;
  let remainingChars = totalChars;
  let textOffset = 0;
  let remainingSpeechSegments = mergedSegments.length;

  const ffmpegCmd = config.FFMPEG_PATH || 'ffmpeg';

  const queueSilence = async (duration: number, outputPath: string): Promise<void> => {
    const effectiveDuration = duration > 0.01 ? duration : 0.01;
    await run(ffmpegCmd, [
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100',
      '-t',
      String(effectiveDuration),
      '-q:a',
      '9',
      outputPath,
    ]);
  };

  const retryDelays = [1000, 2000, 4000];

  const synthesizeWithRetry = async (text: string, outputPath: string): Promise<void> => {
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await synthesizeWithElevenLabsTTS(text, voiceId, outputPath, config.ELEVENLABS_TTS_MODEL_ID);
        return;
      } catch (error) {
        if (error instanceof AppError && error.code === ERROR_CODES.ERR_TTS_RATE_LIMIT && attempt < retryDelays.length) {
          const delayMs = retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 0;
          logger.warn({ delayMs, attempt, voiceId }, 'ElevenLabs TTS rate-limited, retrying');
          await delay(delayMs);
          continue;
        }
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(ERROR_CODES.ERR_TTS_FAILED, 'ElevenLabs TTS request failed', { cause: error });
      }
    }
    throw new AppError(ERROR_CODES.ERR_TTS_RATE_LIMIT, 'ElevenLabs TTS rate limit exhausted');
  };

  for (let i = 0; i < mergedSegments.length; i++) {
    const segment = mergedSegments[i];
    const partPath = path.join(sessionDir, `tts_part_${i}.mp3`);
    audioParts.push(partPath);

    if (!segment) {
      await queueSilence(0.1, partPath);
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
      if (charCount > maxForThisSegment) charCount = maxForThisSegment;
      if (charCount < 0) charCount = 0;
      if (charCount === 0 && remainingChars > minCharsToLeave && maxForThisSegment > 0) {
        charCount = Math.min(1, maxForThisSegment);
      }

      const nextOffset = textOffset + charCount;
      const rawTextPart = translatedText.slice(textOffset, nextOffset);
      textOffset = nextOffset;
      remainingChars -= charCount;
      remainingSpeechSegments = Math.max(0, remainingSpeechSegments - 1);

      const textForSegment = rawTextPart.trim();
      if (!textForSegment.length) {
        await queueSilence(durationSeconds, partPath);
        continue;
      }

      await synthesizeWithRetry(textForSegment, partPath);

      const actualDuration = await getAudioDuration(partPath);
      const targetDuration = durationSeconds;
      
      // Улучшенная корректировка скорости: корректируем в обе стороны
      if (actualDuration > 0 && targetDuration > 0) {
        const durationDiff = Math.abs(actualDuration - targetDuration);
        const tolerance = targetDuration * 0.03; // 3% допуск
        
        if (durationDiff > tolerance) {
          let speed = actualDuration / targetDuration;
          // Ограничиваем скорость изменения: от 0.7x до 1.3x
          if (speed > 1.3) speed = 1.3;
          if (speed < 0.7) speed = 0.7;
          
          const tempPath = `${partPath}.tempo.mp3`;
          await run(ffmpegCmd, [
            '-y',
            '-i',
            partPath,
            '-filter:a',
            `atempo=${speed.toFixed(3)}`,
            tempPath,
          ]);
          await fs.promises.rename(tempPath, partPath);
          logger.debug({ 
            speed, 
            segmentIndex: i, 
            actualDuration, 
            targetDuration,
            adjusted: actualDuration !== targetDuration 
          }, 'Adjusted TTS segment tempo for synchronization');
        }
      }

      // Добавляем паузу перед следующим сегментом на основе временных меток
      if (i < mergedSegments.length - 1) {
        const nextSegment = mergedSegments[i + 1];
        if (nextSegment && isSpeechSegment(nextSegment)) {
          const currentEnd = segment.end;
          const nextStart = nextSegment.start;
          const gap = nextStart - currentEnd;
          
          // Если есть пауза между сегментами (более 0.05 секунд), добавляем её
          if (gap > 0.05) {
            const pausePath = path.join(sessionDir, `tts_pause_${i}.mp3`);
            await queueSilence(gap, pausePath);
            audioParts.push(pausePath);
            logger.debug({ gap, segmentIndex: i, nextSegmentIndex: i + 1, currentEnd, nextStart }, 'Added pause between segments for synchronization');
          }
        }
      }

      continue;
    }

    const pauseDuration = segmentDuration(segment);
    await queueSilence(pauseDuration, partPath);
  }

  if (remainingChars > 0) {
    logger.warn(
      {
        remainingChars,
        totalChars,
        remainingSpeechSegments,
      },
      'Not all translated text was allocated to segments (tts pipeline)'
    );
  }

  const finalVoiceTrackPath = path.join(sessionDir, 'final_voice_track.tts.mp3');
  const existingParts = audioParts.filter((partPath) => fs.existsSync(partPath));
  await concatenateAudioParts(existingParts, finalVoiceTrackPath);

  const finalAudioPath = path.join(sessionDir, 'final_audio.mp3');
  const mixInstrumental = instrumentalPath;
  if (!mixInstrumental) {
    const backgroundMusicPath = path.join(sessionDir, 'background_music.wav');
    await extractBackgroundMusic(downloadPath, backgroundMusicPath);
    await mixVoiceWithBackground(backgroundMusicPath, finalVoiceTrackPath, finalAudioPath);
  } else {
    await mixVoiceWithInstrumental(mixInstrumental, finalVoiceTrackPath, finalAudioPath);
  }

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
  options: TranslationOptions,
  observer?: (stage: TranslationStage) => void
): Promise<TranslationResult> {
  const stages: TranslationStage[] = [];
  const instagram = getProvider('instagram');

  const downloadStage = beginStage('download', stages);
  const { filePath: downloadPath, videoInfo } = await instagram.download(url, sessionDir);
  completeStage(downloadStage);
  await notifyObserver(observer, downloadStage);

  const originalAudioPath = paths.session.originalAudio(sessionDir, videoInfo.id);
  const extractAudioResult = await run(config.FFMPEG_PATH, [
    '-y',
    '-i',
    downloadPath,
    '-vn',
    '-acodec',
    'libmp3lame',
    '-ar',
    '44100',
    '-ac',
    '2',
    originalAudioPath,
  ]);

  if (extractAudioResult.code !== 0) {
    logger.error(
      {
        stderr: extractAudioResult.stderr,
        stdout: extractAudioResult.stdout,
      },
      'Failed to extract audio track to mp3'
    );
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Не удалось извлечь аудио дорожку из видео');
  }

  const separationStage = beginStage('separate', stages);
  let vocalPath: string;
  let instrumentalPath: string;
  try {
    const splitResult = await separateAudioWithLalal(originalAudioPath);
    vocalPath = splitResult.vocalPath;
    instrumentalPath = splitResult.instrumentalPath;
    completeStage(separationStage);
    await notifyObserver(observer, separationStage);
  } catch (error) {
    failStage(separationStage, error);
    await notifyObserver(observer, separationStage);
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        originalAudioPath,
      },
      'LALAL separation failed'
    );
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Не удалось разделить аудио дорожку', { cause: error });
  }

  let voiceIdOverride: string | undefined;
  if (options.voicePreset) {
    const voiceStage = beginStage('select-voice', stages);
    try {
      voiceIdOverride = getVoiceIdForPreset(options.voicePreset);
      if (!voiceIdOverride) {
        throw new AppError(
          ERROR_CODES.ERR_INTERNAL,
          `Указанный голос недоступен. Проверьте переменные ELEVENLABS_TERMINATOR_VOICE_RU/ELEVENLABS_TERMINATOR_VOICE_EN/ELEVENLABS_ZHIRINOVSKY_VOICE_RU/ELEVENLABS_ZHIRINOVSKY_VOICE_EN.`,
          { preset: options.voicePreset }
        );
      }
      completeStage(voiceStage);
      await notifyObserver(observer, voiceStage);
    } catch (error) {
      failStage(voiceStage, error);
      await notifyObserver(observer, voiceStage);
      throw error;
    }
  }

  let pipelineResult: PipelineResult;
  if (options.engine === 'elevenlabs') {
    if (options.mode === 'voice') {
      if (!voiceIdOverride) {
        throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Не настроен голос для озвучки', {
          voicePreset: options.voicePreset,
        });
      }
      pipelineResult = await runElevenLabsTtsPipeline(
        downloadPath,
        originalAudioPath,
        sessionDir,
        options,
        stages,
        observer,
        vocalPath,
        instrumentalPath,
        voiceIdOverride
      );
    } else {
      pipelineResult = await runElevenLabsPipeline(
        originalAudioPath,
        sessionDir,
        videoInfo,
        options,
        stages,
        observer,
        voiceIdOverride
      );
    }
  } else {
    // Hume функционал временно отключен
    // pipelineResult = await runHumePipeline(
    //   downloadPath,
    //   originalAudioPath,
    //   sessionDir,
    //   options,
    //   stages,
    //   observer,
    //   vocalPath,
    //   instrumentalPath
    // );
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Hume функционал временно отключен. Используйте ElevenLabs или голосовые пресеты.');
  }

  const muxStage = beginStage('mux', stages);
  const outputVideoPath = paths.session.finalVideo(sessionDir, videoInfo.id);
  await muxFinalVideo(downloadPath, pipelineResult.audioPath, outputVideoPath);
  completeStage(muxStage);
  await notifyObserver(observer, muxStage);

  const result: TranslationResult = {
    videoPath: outputVideoPath,
    translatedText: pipelineResult.translatedText,
    audioPath: pipelineResult.audioPath,
    stages,
    transcriptPath: pipelineResult.transcriptPath,
    engine: options.engine,
    mode: options.mode,
  };

  if (options.voicePreset) {
    result.voicePreset = options.voicePreset;
  }

  return result;
}
