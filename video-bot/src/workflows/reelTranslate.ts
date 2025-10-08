import * as path from 'path';
import * as fs from 'fs-extra';
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

// Вспомогательные типы и функции (остаются без изменений)
type TimelineSegment = { speaker: string; start: number; end: number };
type AudioAnalysis = { speakers: Record<string, { gender: 'male' | 'female' | 'unknown' }>; segments: TimelineSegment[]; error?: string };
export interface ReelTranslationOptions { direction: TranslationDirection; }
function beginStage(name: TranslationStage['name'], stages: TranslationStage[]): TranslationStage { const stage: TranslationStage = { name, startedAt: Date.now() }; stages.push(stage); return stage; }
async function notifyObserver(observer: ((stage: TranslationStage) => void | Promise<void>) | undefined, stage: TranslationStage): Promise<void> { if (!observer) return; try { await observer(stage); } catch (error) { logger.warn('Stage observer failed', { stage: stage.name, error: error instanceof Error ? error.message : String(error) }); } }
function completeStage(stage: TranslationStage): void { stage.completedAt = Date.now(); }
function failStage(stage: TranslationStage, error: unknown): void { stage.completedAt = Date.now(); stage.error = error instanceof Error ? error.message : String(error); }
function resolveLanguages(direction: TranslationDirection, detected: WhisperLanguage): { source: WhisperLanguage; target: WhisperLanguage; } { if (direction === 'en-ru') return { source: 'en', target: 'ru' }; if (direction === 'ru-en') return { source: 'ru', target: 'en' }; if (detected === 'ru') return { source: 'ru', target: 'en' }; if (detected === 'en') return { source: 'en', target: 'ru' }; return { source: 'unknown', target: 'ru' }; }
function selectVoiceId(target: WhisperLanguage, gender: 'male' | 'female' | 'unknown'): string { const isRussian = target === 'ru'; if (isRussian) { return gender === 'male' ? config.HUME_VOICE_ID_RU_MALE : config.HUME_VOICE_ID_RU_FEMALE; } return gender === 'male' ? config.HUME_VOICE_ID_EN_MALE : config.HUME_VOICE_ID_EN_FEMALE; }


export async function translateInstagramReel(
  url: string,
  sessionDir: string,
  options: ReelTranslationOptions,
  observer?: (stage: TranslationStage) => void
): Promise<TranslationResult> {
  const stages: TranslationStage[] = [];
  const instagram = getProvider('instagram');

  // 1. Download
  const downloadStage = beginStage('download', stages);
  const { filePath: downloadPath, videoInfo } = await instagram.download(url, sessionDir);
  completeStage(downloadStage);
  await notifyObserver(observer, downloadStage);

  // 2. Audio Analysis
  const analysisStage = beginStage('analyze-audio', stages);
  let analysis: AudioAnalysis;
  try {
    const fullAudioPath = path.join(sessionDir, `${videoInfo.id}.wav`);
    await run(ffmpegBinary, ['-y', '-i', downloadPath, '-ar', '16000', '-ac', '1', fullAudioPath]);
    const wavExists = await fs.pathExists(fullAudioPath);
    if (!wavExists) {
      throw new Error(`FFmpeg did not produce expected audio file at ${fullAudioPath}`);
    }
    
    const analysisScriptPath = path.join(process.cwd(), 'scripts', 'analyze_audio.py');
    const analysisResult = await run('python3', [analysisScriptPath, fullAudioPath], { timeout: 120000 });
    
    // --- КЛЮЧЕВОЕ ИЗМЕНЕНИЕ ---
    // Проверяем, есть ли вообще вывод, прежде чем парсить
    if (!analysisResult.stdout) {
        logger.error('Audio analysis script produced no output', {
            code: analysisResult.code,
            stderr: analysisResult.stderr,
        });
        throw new Error('Audio analysis script produced no output.');
    }

    analysis = JSON.parse(analysisResult.stdout) as AudioAnalysis;
    if (analysis.error) {
        throw new Error(`Audio analysis script returned an error: ${analysis.error}`);
    }

    logger.info('Audio analysis complete', { speakers: Object.keys(analysis.speakers).length, segments: analysis.segments.length });
    completeStage(analysisStage);
    await notifyObserver(observer, analysisStage);
  } catch (error) {
      failStage(analysisStage, error);
      await notifyObserver(observer, analysisStage);
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed during audio analysis stage.', { cause: error });
  }

  // --- Остальная логика ---
  const transcribeStage = beginStage('transcribe', stages);
  const fullAudioPathForWhisper = path.join(sessionDir, `${videoInfo.id}.wav`);
  const whisperOutput = await transcribeWithWhisper(fullAudioPathForWhisper);
  completeStage(transcribeStage);
  await notifyObserver(observer, transcribeStage);
  
  const { source, target } = resolveLanguages(options.direction, whisperOutput.language);
  
  const translateStage = beginStage('translate', stages);
  const translatedText = await translateText(whisperOutput.text, source, target);
  completeStage(translateStage);
  await notifyObserver(observer, translateStage);

  // Промежуточная логика для Шага 2
  const synthStage = beginStage('synthesize', stages);
  const mainSpeakerId = analysis.segments[0]?.speaker;
  const gender = mainSpeakerId ? (analysis.speakers[mainSpeakerId]?.gender || 'unknown') : 'unknown';
  const voiceId = selectVoiceId(target, gender);
  
  const dubbedAudioPath = path.join(sessionDir, `${videoInfo.id}.dub.mp3`);
  await synthesizeSpeech(translatedText, dubbedAudioPath, { voiceId });
  completeStage(synthStage);
  await notifyObserver(observer, synthStage);

  const muxStage = beginStage('mux', stages);
  const outputVideoPath = path.join(sessionDir, `${videoInfo.id}.final.mp4`);
  await muxFinalVideo(downloadPath, dubbedAudioPath, outputVideoPath);
  completeStage(muxStage);
  await notifyObserver(observer, muxStage);
  
  return { videoPath: outputVideoPath, translatedText, audioPath: dubbedAudioPath, stages, transcriptPath: '' };
}
