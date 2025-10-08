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
import type { VideoInfo } from '../providers/types';
import type { ExecResult } from '../core/exec';
import { ensurePythonAudioDeps } from '../core/pythonDeps';

const ffmpegBinary = process.env['FFMPEG_PATH'] || 'ffmpeg';

// Вспомогательные типы и функции
type TimelineSegment = { speaker: string; start: number; end: number };
type AudioAnalysis = { speakers: Record<string, { gender: 'male' | 'female' | 'unknown' }>; segments: TimelineSegment[]; error?: string };
type AnalysisScriptOutput = AudioAnalysis & { error?: string; traceback?: string; stage?: string };
export interface ReelTranslationOptions { direction: TranslationDirection; }
function beginStage(name: TranslationStage['name'], stages: TranslationStage[]): TranslationStage { const stage: TranslationStage = { name, startedAt: Date.now() }; stages.push(stage); return stage; }
async function notifyObserver(observer: ((stage: TranslationStage) => void | Promise<void>) | undefined, stage: TranslationStage): Promise<void> { if (!observer) return; try { await observer(stage); } catch (error) { logger.warn('Stage observer failed', { stage: stage.name, error: error instanceof Error ? error.message : String(error) }); } }
function completeStage(stage: TranslationStage): void { stage.completedAt = Date.now(); }
function failStage(stage: TranslationStage, error: unknown): void { stage.completedAt = Date.now(); stage.error = error instanceof Error ? error.message : String(error); }
function resolveLanguages(direction: TranslationDirection, detected: WhisperLanguage): { source: WhisperLanguage; target: WhisperLanguage; } { if (direction === 'en-ru') return { source: 'en', target: 'ru' }; if (direction === 'ru-en') return { source: 'ru', target: 'en' }; if (detected === 'ru') return { source: 'ru', target: 'en' }; if (detected === 'en') return { source: 'en', target: 'ru' }; return { source: 'unknown', target: 'ru' }; }
function selectVoiceId(target: WhisperLanguage, gender: 'male' | 'female' | 'unknown'): string { const isRussian = target === 'ru'; if (isRussian) { return gender === 'male' ? config.HUME_VOICE_ID_RU_MALE : config.HUME_VOICE_ID_RU_FEMALE; } return gender === 'male' ? config.HUME_VOICE_ID_EN_MALE : config.HUME_VOICE_ID_EN_FEMALE; }
function truncateForLog(value: string | undefined | null, max = 800): string | undefined { if (!value) return value ?? undefined; if (value.length <= max) return value; return `${value.slice(0, max)}…[truncated]`; }

export async function translateInstagramReel(
  url: string,
  sessionDir: string,
  options: ReelTranslationOptions,
  observer?: (stage: TranslationStage) => void
): Promise<TranslationResult> {
  const stages: TranslationStage[] = [];
  const instagram = getProvider('instagram');

  const startStage = (name: TranslationStage['name'], meta: Record<string, unknown> = {}) => {
    const stage = beginStage(name, stages);
    logger.info(
      { stage: name, url, sessionDir, ...meta },
      'Reel translation stage started'
    );
    return stage;
  };

  const completeStageWithLog = (stage: TranslationStage, meta: Record<string, unknown> = {}) => {
    completeStage(stage);
    const durationMs = (stage.completedAt ?? Date.now()) - stage.startedAt;
    logger.info(
      { stage: stage.name, durationMs, ...meta },
      'Reel translation stage completed'
    );
  };

  const failStageWithLog = (stage: TranslationStage, error: unknown, meta: Record<string, unknown> = {}) => {
    failStage(stage, error);
    const durationMs = (stage.completedAt ?? Date.now()) - stage.startedAt;
    logger.error(
      {
        stage: stage.name,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        ...meta,
      },
      'Reel translation stage failed'
    );
  };

  // 1) Download
  const downloadStage = startStage('download');
  let downloadPath: string;
  let videoInfo: VideoInfo;
  try {
    const downloadResult = await instagram.download(url, sessionDir);
    downloadPath = downloadResult.filePath;
    videoInfo = downloadResult.videoInfo;
    completeStageWithLog(downloadStage, { videoPath: downloadPath, videoId: videoInfo.id });
    await notifyObserver(observer, downloadStage);
  } catch (error) {
    failStageWithLog(downloadStage, error);
    await notifyObserver(observer, downloadStage);
    throw error;
  }

  // 2) Analyze audio with Python (robust logs)
  const analysisStage = startStage('analyze-audio', { hasHfToken: Boolean(process.env['HF_TOKEN']) });
  const fullAudioPath = path.join(sessionDir, `${videoInfo.id}.wav`);
  let analysis: AudioAnalysis = { speakers: {}, segments: [] };
  let ffmpegResult: ExecResult | undefined;
  let analysisResult: ExecResult | undefined;

  try {
    await ensurePythonAudioDeps();
    logger.info(
      { sourceVideo: downloadPath, wavTarget: fullAudioPath, ffmpegBinary },
      'Preparing audio for analysis'
    );
    ffmpegResult = await run(ffmpegBinary, ['-y', '-i', downloadPath, '-ar', '16000', '-ac', '1', fullAudioPath]);
    if (ffmpegResult.code !== 0) {
      throw new Error(`FFmpeg conversion failed with code ${ffmpegResult.code}`);
    }
    logger.info(
      {
        durationMs: ffmpegResult.durationMs,
        ffmpegStdout: ffmpegResult.stdout,
        ffmpegStderr: ffmpegResult.stderr,
      },
      'FFmpeg audio extraction finished'
    );

    const analysisScriptPath = path.join(process.cwd(), 'scripts', 'analyze_audio.py');
    logger.info({ script: analysisScriptPath }, 'Running audio analysis script');
    analysisResult = await run('python3', [analysisScriptPath, fullAudioPath], { timeout: 120000 });

    logger.info(
      {
        exitCode: analysisResult.code,
        stdout: analysisResult.stdout,
        stderr: analysisResult.stderr,
      },
      'Audio analysis raw output'
    );

    let parsed: AnalysisScriptOutput | null = null;
    try {
      parsed = analysisResult.stdout ? (JSON.parse(analysisResult.stdout) as AnalysisScriptOutput) : null;
    } catch (parseError) {
      logger.error(
        {
          parseError: parseError instanceof Error ? parseError.message : String(parseError),
          stdout: analysisResult.stdout,
        },
        'Failed to parse audio analysis JSON output'
      );
    }

    if (analysisResult.code !== 0) {
      const message = parsed?.error
        ? `Audio analysis script exited with code ${analysisResult.code}: ${parsed.error}`
        : `Audio analysis script exited with code ${analysisResult.code}`;
      const error = new Error(message);
      if (parsed?.traceback) (error as any).traceback = parsed.traceback;
      throw error;
    }

    if (!parsed) {
      throw new Error('Audio analysis script returned empty output');
    }

    if (parsed.error) {
      const error = new Error(parsed.error);
      if (parsed.traceback) (error as any).traceback = parsed.traceback;
      throw error;
    }

    analysis = { speakers: parsed.speakers, segments: parsed.segments };
    logger.info(
      {
        speakers: Object.keys(analysis.speakers).length,
        segments: analysis.segments.length,
      },
      'Audio analysis complete'
    );
    completeStageWithLog(analysisStage);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    failStageWithLog(analysisStage, err, {
      ffmpegCode: ffmpegResult?.code,
      ffmpegStdout: ffmpegResult?.stdout,
      ffmpegStderr: ffmpegResult?.stderr,
      analysisCode: analysisResult?.code,
      analysisStdout: analysisResult?.stdout,
      analysisStderr: analysisResult?.stderr,
      wavExists: ffmpegResult?.code === 0,
      traceback: (err as any)?.traceback,
    });
    await notifyObserver(observer, analysisStage);
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Audio analysis failed', {
      reason: err.message,
      traceback: (err as any)?.traceback,
      ffmpeg: {
        code: ffmpegResult?.code,
        stdout: ffmpegResult?.stdout,
        stderr: ffmpegResult?.stderr,
      },
      analysis: {
        code: analysisResult?.code,
        stdout: analysisResult?.stdout,
        stderr: analysisResult?.stderr,
      },
    });
  }
  await notifyObserver(observer, analysisStage);

  // 3) Transcribe & Translate (unchanged apart from structure)
  const transcribeStage = startStage('transcribe', { audioPath: path.join(sessionDir, `${videoInfo.id}.wav`) });
  let whisperOutput: Awaited<ReturnType<typeof transcribeWithWhisper>>;
  try {
    whisperOutput = await transcribeWithWhisper(path.join(sessionDir, `${videoInfo.id}.wav`));
    completeStageWithLog(transcribeStage, {
      detectedLanguage: whisperOutput.language,
      detectedLanguageConfidence: whisperOutput.detectedLanguageConfidence,
      transcriptLength: whisperOutput.text.length,
    });
  } catch (error) {
    failStageWithLog(transcribeStage, error);
    await notifyObserver(observer, transcribeStage);
    throw error;
  }
  await notifyObserver(observer, transcribeStage);

  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);
  logger.info('Resolved translation languages', { requestedDirection: options.direction, detected: whisperOutput.language, source, target });

  const translateStage = startStage('translate', { sourceLanguage: source, targetLanguage: target });
  let translatedText = '';
  try {
    translatedText = await translateText(whisperOutput.text, source, target);
    completeStageWithLog(translateStage, {
      translatedTextLength: translatedText.length,
      transcriptPreview: truncateForLog(translatedText, 400),
    });
  } catch (error) {
    failStageWithLog(translateStage, error);
    await notifyObserver(observer, translateStage);
    throw error;
  }
  await notifyObserver(observer, translateStage);

  // 4) Synthesize with first speaker gender
  const mainSpeakerId = analysis.segments[0]?.speaker;
  const gender = mainSpeakerId ? (analysis.speakers[mainSpeakerId]?.gender || 'unknown') : 'unknown';
  const voiceId = selectVoiceId(target, gender);
  const dubbedAudioPath = path.join(sessionDir, `${videoInfo.id}.dub.mp3`);
  const synthStage = startStage('synthesize', { voiceId, gender, targetLanguage: target });
  try {
    await synthesizeSpeech(translatedText, dubbedAudioPath, {
      voiceId,
      language: target === 'ru' ? 'ru' : 'en',
      description: `Reel translation ${videoInfo.id}`,
    });
    completeStageWithLog(synthStage, { dubbedAudioPath });
  } catch (error) {
    failStageWithLog(synthStage, error, { voiceId });
    await notifyObserver(observer, synthStage);
    throw error;
  }
  await notifyObserver(observer, synthStage);

  // 5) Mux
  const muxStage = startStage('mux', { originalVideoPath: downloadPath, dubbedAudioPath });
  const outputVideoPath = path.join(sessionDir, `${videoInfo.id}.final.mp4`);
  try {
    await muxFinalVideo(downloadPath, dubbedAudioPath, outputVideoPath);
    completeStageWithLog(muxStage, { outputVideoPath });
  } catch (error) {
    failStageWithLog(muxStage, error);
    await notifyObserver(observer, muxStage);
    throw error;
  }
  await notifyObserver(observer, muxStage);

  logger.info('Reel translation workflow completed successfully', {
    url,
    outputVideoPath,
    dubbedAudioPath,
    translatedTextLength: translatedText.length,
  });

  return { videoPath: outputVideoPath, translatedText, audioPath: dubbedAudioPath, stages, transcriptPath: '' };
}
