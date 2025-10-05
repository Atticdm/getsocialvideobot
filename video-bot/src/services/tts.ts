import axios from 'axios';
import * as fs from 'fs/promises';
import { config } from '../core/config';
import { AppError, ERROR_CODES } from '../core/errors';
import { logger } from '../core/logger';

const HUME_TTS_URL = 'https://api.hume.ai/v0/evi/synthesize';

type TtsOptions = {
  voiceId?: string;
  audioFormat?: string;
};

export async function synthesizeSpeech(
  text: string,
  outputPath: string,
  options: TtsOptions = {}
): Promise<string> {
  if (!config.HUME_API_KEY || !config.HUME_CLIENT_SECRET) {
    throw new AppError(
      ERROR_CODES.ERR_TTS_FAILED,
      'Hume credentials missing',
      { hint: 'Set HUME_API_KEY and HUME_CLIENT_SECRET' }
    );
  }

  const voiceId = options.voiceId || config.HUME_VOICE_ID || 'octave-2-evi';

  try {
    const response = await axios.post(
      HUME_TTS_URL,
      {
        text,
        voice: {
          name: voiceId,
        },
      },
      {
        auth: {
          username: config.HUME_API_KEY,
          password: config.HUME_CLIENT_SECRET,
        },
        responseType: 'arraybuffer',
        timeout: 240000,
      }
    );

    const buffer = Buffer.from(response.data);
    await fs.writeFile(outputPath, buffer);
    return outputPath;
  } catch (error) {
    logger.error('Hume TTS synthesis failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AppError(
      ERROR_CODES.ERR_TTS_FAILED,
      'TTS request failed',
      { cause: error }
    );
  }
}
