import * as path from 'path';
import * as fs from 'fs-extra';
import { getProvider } from '../providers';
import { AppError, ERROR_CODES } from '../core/errors';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { concatenateAudioParts, muxFinalVideo } from '../core/media';
import { run } from '../core/exec';
import { transcribeWithWhisper } from '../services/whisper';
import { translateText } from '../services/translator';
import { synthesizeSpeech } from '../services/tts';
import { paths } from '../core/paths';
import {
  TranslationDirection,
  TranslationResult,
  TranslationStage,
  WhisperLanguage,
} from '../types/translation';

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

  const speechSegments = analysis.segments.filter((segment) => (segment.type ?? 'speech') === 'speech');
  const totalSpeechDuration = speechSegments.reduce(
    (sum, segment) => sum + Math.max(0, segment.end - segment.start),
    0
  );
  let textOffset = 0;

  for (let i = 0; i < analysis.segments.length; i++) {
    const segment = analysis.segments[i];
    if (!segment) {
      logger.warn({ index: i }, 'Timeline segment missing');
      continue;
    }
    const partPath = path.join(sessionDir, `part_${i}.mp3`);
    audioParts.push(partPath);

    const isSpeech = (segment.type ?? 'speech') === 'speech';

    if (isSpeech) {
      const segmentDuration = Math.max(0, segment.end - segment.start);
      const proportion = totalSpeechDuration > 0 ? segmentDuration / totalSpeechDuration : 0;
      const textPartLength = Math.round(proportion * translatedText.length);
      const textPart = translatedText.substring(textOffset, textOffset + textPartLength);
      textOffset += textPartLength;

      if (textPart.trim().length > 0) {
        synthesisTasks.push(
          (async () => {
            const estimatedDuration = textPart.length / 15;
            const speed = segmentDuration > 0.1 ? estimatedDuration / segmentDuration : 1.0;
            const cappedSpeed = Math.max(0.7, Math.min(speed, 1.8));
            const gender = analysis.speakers[segment.speaker]?.gender || 'unknown';
            const voiceId = selectVoiceId(target, gender);
            await synthesizeSpeech(textPart, partPath, { voiceId, speed: cappedSpeed });
          })()
        );
      } else {
        synthesisTasks.push(
          run(config.FFMPEG_PATH, [
            '-f',
            'lavfi',
            '-i',
            'anullsrc=r=44100',
            '-t',
            String(segmentDuration),
            '-q:a',
            '9',
            partPath,
          ]).then(() => undefined)
        );
      }
    } else {
      const pauseDuration = Math.max(0, segment.end - segment.start);
      if (pauseDuration > 0.05) {
        synthesisTasks.push(
          run(config.FFMPEG_PATH, [
            '-f',
            'lavfi',
            '-i',
            'anullsrc=r=44100',
            '-t',
            String(pauseDuration),
            '-q:a',
            '9',
            partPath,
          ]).then(() => undefined)
        );
      }
    }
  }

  await Promise.all(synthesisTasks);
  const finalAudioPath = path.join(sessionDir, 'final_audio.mp3');
  const existingParts = audioParts.filter((partPath) => fs.existsSync(partPath));
  await concatenateAudioParts(existingParts, finalAudioPath);
  completeStage(synthStage);
  await notifyObserver(observer, synthStage);

  const muxStage = beginStage('mux', stages);
  const outputVideoPath = paths.session.finalVideo(sessionDir, videoInfo.id);
  await muxFinalVideo(downloadPath, finalAudioPath, outputVideoPath);
  completeStage(muxStage);
  await notifyObserver(observer, muxStage);

  return {
    videoPath: outputVideoPath,
    translatedText,
    audioPath: finalAudioPath,
    stages,
    transcriptPath: '',
  };
}
