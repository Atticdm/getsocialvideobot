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

function selectVoiceId(target: WhisperLanguage, gender: 'male' | 'female' | 'unknown'): string {
  const isRussian = target === 'ru';
  if (isRussian) {
    return gender === 'male' ? config.HUME_VOICE_ID_RU_MALE : config.HUME_VOICE_ID_RU_FEMALE;
  }
  return gender === 'male' ? config.HUME_VOICE_ID_EN_MALE : config.HUME_VOICE_ID_EN_FEMALE;
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

type TimelineSegment = { type: 'speech' | 'pause'; start: number; end: number };
type AudioAnalysis = { gender: 'male' | 'female' | 'unknown'; timeline: TimelineSegment[] };

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

  const providerName = detectProvider(url);
  if (providerName !== 'instagram') {
    throw new AppError(
      ERROR_CODES.ERR_TRANSLATION_NOT_SUPPORTED,
      'Only Instagram reels are supported for translation right now',
      { url, provider: providerName }
    );
  }

  const instagram = getProvider('instagram');

  const downloadStage = beginStage('download', stages);
  let downloadPath: string;
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

  const analysisStage = beginStage('analyze-audio', stages);
  const fullAudioPath = path.join(sessionDir, `${videoId}.wav`);
  let analysis: AudioAnalysis | null = null;
  try {
    await run(ffmpegBinary, ['-y', '-i', downloadPath, '-ar', '16000', '-ac', '1', fullAudioPath]);

    const analysisScriptPath = path.join(process.cwd(), 'scripts', 'detect_gender.py');
    const analysisResult = await run('python3', [analysisScriptPath, fullAudioPath], { timeout: 60000 });
    if (analysisResult.code !== 0) {
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Audio analysis script failed', { stderr: analysisResult.stderr });
    }

    const parsed: AudioAnalysis = JSON.parse(analysisResult.stdout || '{}');
    if (!parsed.timeline || parsed.timeline.length === 0) {
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Audio analysis returned empty timeline');
    }
    analysis = parsed;
    logger.info('Audio analysis complete', { gender: analysis.gender, segments: analysis.timeline.length });
    completeStage(analysisStage);
    await notifyObserver(observer, analysisStage);
  } catch (error) {
    failStage(analysisStage, error);
    await notifyObserver(observer, analysisStage);
    throw error;
  }

  const workflowCtx: WorkflowContext = {
    downloadPath,
    videoId,
    fullAudioPath,
    timeline: analysis.timeline,
    gender: analysis.gender,
    stages,
    options,
    ...(observer ? { observer } : {}),
  };

  return continueWorkflow(workflowCtx);
}

type WorkflowContext = {
  downloadPath: string;
  videoId: string;
  fullAudioPath: string;
  timeline: TimelineSegment[];
  gender: 'male' | 'female' | 'unknown';
  stages: TranslationStage[];
  observer?: ((stage: TranslationStage) => void | Promise<void>) | undefined;
  options: ReelTranslationOptions;
};

async function continueWorkflow(ctx: WorkflowContext): Promise<TranslationResult> {
  const { downloadPath, videoId, fullAudioPath, timeline, gender, stages, observer, options } = ctx;

  const transcribeStage = beginStage('transcribe', stages);
  let whisperOutput: Awaited<ReturnType<typeof transcribeWithWhisper>>;
  try {
    whisperOutput = await transcribeWithWhisper(fullAudioPath);
    await fs.writeFile(path.join(path.dirname(fullAudioPath), `${videoId}.transcript.txt`), whisperOutput.text, 'utf8');
    completeStage(transcribeStage);
    await notifyObserver(observer, transcribeStage);
  } catch (error) {
    failStage(transcribeStage, error);
    await notifyObserver(observer, transcribeStage);
    throw error;
  }

  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);

  const translateStage = beginStage('translate', stages);
  let translatedText = '';
  try {
    translatedText = await translateText(whisperOutput.text, source, target);
    await fs.writeFile(path.join(path.dirname(fullAudioPath), `${videoId}.translation.txt`), translatedText, 'utf8');
    completeStage(translateStage);
    await notifyObserver(observer, translateStage);
  } catch (error) {
    failStage(translateStage, error);
    await notifyObserver(observer, translateStage);
    throw error;
  }

  const synthStage = beginStage('synthesize', stages);
  const audioParts: string[] = [];
  try {
    const speechSegments = timeline.filter((s) => s.type === 'speech');
    const totalSpeechDuration = speechSegments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);

    const words = translatedText.trim().split(/\s+/).filter(Boolean);
    let wordCursor = 0;
    const totalWords = words.length;

    for (let i = 0, speechIndex = 0; i < timeline.length; i++) {
      const segment = timeline[i]!;
      const segmentDuration = Math.max(0.1, segment.end - segment.start);
      const partPath = path.join(path.dirname(fullAudioPath), `part_${i}.mp3`);

      if (segment.type === 'speech') {
        const remainingWords = totalWords - wordCursor;
        let wordCount = remainingWords;
        if (speechSegments.length > 0 && totalSpeechDuration > 0 && speechIndex < speechSegments.length - 1) {
          const proportion = segmentDuration / totalSpeechDuration;
          wordCount = Math.max(1, Math.round(proportion * totalWords));
          wordCount = Math.min(wordCount, remainingWords);
        }
        if (speechIndex === speechSegments.length - 1) {
          wordCount = remainingWords;
        }

        const segmentWords = words.slice(wordCursor, wordCursor + wordCount);
        const textPart = segmentWords.join(' ');
        wordCursor += wordCount;
        speechIndex += 1;

        const estimatedDuration = segmentWords.length ? segmentWords.length / 2.8 : 0.6;
        const desiredDuration = segmentDuration * 0.95;
        const rawSpeed = desiredDuration > 0 ? estimatedDuration / desiredDuration : 1.0;
        const speed = Math.max(0.55, Math.min(rawSpeed, 1.9));
        const voiceId = selectVoiceId(target, gender);

        await synthesizeSpeech(textPart || '.', partPath, {
          voiceId,
          speed,
          language: target === 'ru' ? 'ru' : 'en',
        });
      } else {
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

    if (wordCursor < totalWords && audioParts.length > 0) {
      const remainingText = words.slice(wordCursor).join(' ');
      if (remainingText) {
        await synthesizeSpeech(remainingText, audioParts[audioParts.length - 1]!, {
          voiceId: selectVoiceId(target, gender),
          speed: 1.0,
          language: target === 'ru' ? 'ru' : 'en',
        });
      }
    }

    completeStage(synthStage);
    await notifyObserver(observer, synthStage);
  } catch (error) {
    failStage(synthStage, error);
    await notifyObserver(observer, synthStage);
    throw error;
  }

  const muxStage = beginStage('mux', stages);
  const finalAudioPath = path.join(path.dirname(fullAudioPath), `${videoId}.final.mp3`);
  const outputVideoPath = path.join(path.dirname(fullAudioPath), `${videoId}.final.mp4`);
  try {
    await concatenateAudioParts(audioParts, finalAudioPath);
    await muxFinalVideo(downloadPath, finalAudioPath, outputVideoPath);
    completeStage(muxStage);
    await notifyObserver(observer, muxStage);
  } catch (error) {
    failStage(muxStage, error);
    await notifyObserver(observer, muxStage);
    throw error;
  }

  return {
    videoPath: outputVideoPath,
    transcriptPath: path.join(path.dirname(fullAudioPath), `${videoId}.transcript.txt`),
    translatedText,
    audioPath: finalAudioPath,
    stages,
  };
}
