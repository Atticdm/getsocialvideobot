import axios from 'axios';
import * as fs from 'fs/promises';
import { config } from '../core/config';
import { AppError, ERROR_CODES } from '../core/errors';
import { logger } from '../core/logger';

const HUME_TTS_URL = 'https://api.hume.ai/v0/tts/file';

type TtsOptions = {
  voiceId?: string;
  speed?: number;
  language?: 'en' | 'ru';
  description?: string;
  trailingSilence?: number;
  gender?: 'male' | 'female' | 'unknown';
  emotion?: { name: string; score?: number } | string;
};

export async function synthesizeSpeech(
  text: string,
  outputPath: string,
  options: TtsOptions = {}
): Promise<string> {
  if (!config.HUME_API_KEY) {
    throw new AppError(
      ERROR_CODES.ERR_TTS_FAILED,
      'Hume API key missing',
      { hint: 'Set HUME_API_KEY' }
    );
  }

  const utterance: Record<string, unknown> = {
    text,
  };

  const descriptionParts: string[] = [];

  if (options.voiceId) {
    utterance['voice'] = { id: options.voiceId };
  }

  if (typeof options.speed === 'number' && Number.isFinite(options.speed)) {
    const clampedSpeed = Math.max(0.5, Math.min(options.speed, 2));
    utterance['speed'] = Number(clampedSpeed.toFixed(2));
  }

  if (typeof options.trailingSilence === 'number' && options.trailingSilence > 0) {
    utterance['trailing_silence'] = Number(options.trailingSilence.toFixed(3));
  }

  if (options.gender) {
    descriptionParts.push(`gender=${options.gender}`);
  }

  if (options.emotion) {
    if (typeof options.emotion === 'string') {
      descriptionParts.push(`emotion=${options.emotion}`);
    } else if (options.emotion.name) {
      const scorePart = typeof options.emotion.score === 'number' ? `:${options.emotion.score.toFixed(3)}` : '';
      descriptionParts.push(`emotion=${options.emotion.name}${scorePart}`);
    }
  }

  if (options.description && options.description.trim().length > 0) {
    descriptionParts.push(options.description.trim());
  }

  if (descriptionParts.length > 0) {
    utterance['description'] = descriptionParts.join('; ');
  }

  const requestBody: Record<string, unknown> = {
    utterances: [utterance],
  };

  if (options.language === 'ru') {
    requestBody['language_model'] = {
      model_provider: 'HUME_AI',
      model_resource: 'russian-v1',
    };
  }

  try {
    const response = await axios.post(
      HUME_TTS_URL,
      requestBody,
      {
        headers: {
          'X-Hume-Api-Key': config.HUME_API_KEY,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
        timeout: 240000,
      }
    );

    const buffer = Buffer.from(response.data);
    await fs.writeFile(outputPath, buffer);
    return outputPath;
  } catch (error: any) {
    const errorDetails: Record<string, unknown> = {
      message: error?.message,
    };

    if (error?.response) {
      errorDetails['status'] = error.response.status;
      if (error.response.data instanceof Buffer) {
        errorDetails['data'] = error.response.data.toString('utf-8');
      } else {
        errorDetails['data'] = error.response.data;
      }
    }

    logger.error({
      err: error,
      details: errorDetails,
    }, 'Hume TTS synthesis failed');
    throw new AppError(
      ERROR_CODES.ERR_TTS_FAILED,
      'TTS request failed',
      { cause: errorDetails }
    );
  }
}
