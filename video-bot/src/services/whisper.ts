import axios, { isAxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import { config } from '../core/config';
import { AppError, ERROR_CODES } from '../core/errors';
import { logger } from '../core/logger';
import { WhisperOutput } from '../types/translation';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

export async function transcribeWithWhisper(audioPath: string): Promise<WhisperOutput> {
  if (!config.OPENAI_API_KEY) {
    throw new AppError(
      ERROR_CODES.ERR_TRANSCRIPTION_FAILED,
      'OpenAI API key missing for transcription',
      { hint: 'Set OPENAI_API_KEY in environment' }
    );
  }

  const model = config.OPENAI_WHISPER_MODEL || 'whisper-1';
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath), path.basename(audioPath));
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  try {
    const response = await axios.post(OPENAI_TRANSCRIBE_URL, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
      timeout: 240000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const data = response.data || {};
    const language = typeof data.language === 'string' ? data.language.toLowerCase() : 'unknown';
    const mappedLanguage = language.startsWith('en') ? 'en' : language.startsWith('ru') ? 'ru' : 'unknown';

    return {
      text: data.text || '',
      language: mappedLanguage,
      detectedLanguageConfidence: data.language_confidence,
    };
  } catch (error) {
    if (isAxiosError(error)) {
      const responseData = error.response?.data;
      const normalizedData = typeof responseData === 'string'
        ? responseData.slice(0, 2000)
        : responseData ? JSON.stringify(responseData).slice(0, 2000) : undefined;

      logger.error('Whisper transcription failed', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        dataPreview: normalizedData,
        headers: error.response?.headers,
        url: error.config?.url,
        method: error.config?.method,
      });

      throw new AppError(
        ERROR_CODES.ERR_TRANSCRIPTION_FAILED,
        'Transcription request failed',
        {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: normalizedData,
        }
      );
    }

    logger.error('Whisper transcription failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AppError(
      ERROR_CODES.ERR_TRANSCRIPTION_FAILED,
      'Transcription request failed',
      { cause: error }
    );
  }
}
