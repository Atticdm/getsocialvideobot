import axios from 'axios';
import * as fs from 'fs/promises';
import { config } from '../core/config';
import { AppError, ERROR_CODES } from '../core/errors';
import { logger } from '../core/logger';

// Новый, правильный URL для TTS API
const HUME_TTS_URL = 'https://api.hume.ai/v0/tts/file';

type TtsOptions = {
  voiceId?: string;
  audioFormat?: string;
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

  try {
    const response = await axios.post(
      HUME_TTS_URL,
      {
        utterances: [
          {
            text,
            description: `A voice with the characteristics of: ${options.voiceId || config.HUME_VOICE_ID}`,
          },
        ],
      },
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
      errorDetails['statusText'] = error.response.statusText;
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
