import axios from 'axios';
import * as fs from 'fs/promises';
import { config } from '../core/config';
import { AppError, ERROR_CODES } from '../core/errors';
import { logger } from '../core/logger';

const HUME_TTS_URL = 'https://api.hume.ai/v0/tts/file';

type TtsOptions = {
  voiceId?: string;
  speed?: number;
  gender?: 'male' | 'female' | 'unknown';
  emotion?: { name: string; score?: number };
  trailingSilence?: number;
  descriptionHint?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function synthesizeSpeech(
  text: string,
  outputPath: string,
  options: TtsOptions = {}
): Promise<string> {
  if (!config.HUME_API_KEY) {
    throw new AppError(ERROR_CODES.ERR_TTS_FAILED, 'Hume API key missing');
  }

  const utterance: Record<string, unknown> = {
    text: text && text.trim().length ? text : '.',
  };

  if (options.voiceId) {
    utterance['voice'] = { id: options.voiceId };
  }

  if (typeof options.speed === 'number' && Number.isFinite(options.speed)) {
    utterance['speed'] = Number(clamp(options.speed, 0.5, 2.0).toFixed(2));
  }

  if (typeof options.trailingSilence === 'number' && Number.isFinite(options.trailingSilence)) {
    utterance['trailing_silence'] = Number(clamp(options.trailingSilence, 0, 5).toFixed(3));
  }

  const descriptionParts: string[] = [];

  if (options.gender && options.gender !== 'unknown') {
    descriptionParts.push(`Gender: ${options.gender}`);
  }

  if (options.emotion?.name) {
    const rawScore = options.emotion.score;
    const intensity =
      typeof rawScore === 'number' && Number.isFinite(rawScore)
        ? Number(clamp(rawScore, 0, 1).toFixed(3))
        : undefined;
    const emotionSegment = intensity !== undefined
      ? `Emotion: ${options.emotion.name} (${intensity})`
      : `Emotion: ${options.emotion.name}`;
    descriptionParts.push(emotionSegment);
  }

  if (options.descriptionHint && options.descriptionHint.trim().length > 0) {
    descriptionParts.push(options.descriptionHint.trim());
  }

  if (descriptionParts.length > 0) {
    utterance['description'] = descriptionParts.join('; ');
  }

  const requestBody = {
    utterances: [utterance],
  };

  try {
    const response = await axios.post(HUME_TTS_URL, requestBody, {
      headers: {
        'X-Hume-Api-Key': config.HUME_API_KEY,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 240000,
    });

    await fs.writeFile(outputPath, Buffer.from(response.data));
    return outputPath;
  } catch (error: any) {
    const errorDetails: Record<string, unknown> = {
      message: error?.message,
    };

    if (error?.response) {
      errorDetails['status'] = error.response.status;
      errorDetails['data'] = error.response.data instanceof Buffer
        ? error.response.data.toString('utf-8')
        : error.response.data;
    }

    logger.error({
      err: error,
      details: errorDetails,
      requestBody,
    }, 'Hume TTS synthesis failed');
    throw new AppError(ERROR_CODES.ERR_TTS_FAILED, 'TTS request failed', { cause: errorDetails });
  }
}
