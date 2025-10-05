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

  const requestBody: any = {
    utterances: [
      {
        text: text,
        description: `A voice with ID: ${options.voiceId}`,
      },
    ],
    speed: options.speed || 1.0,
  };

  if (options.language === 'ru') {
    requestBody.language_model = {
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

    logger.error('Hume TTS synthesis failed', { error: errorDetails });
    throw new AppError(
      ERROR_CODES.ERR_TTS_FAILED,
      'TTS request failed',
      { cause: errorDetails }
    );
  }
}
