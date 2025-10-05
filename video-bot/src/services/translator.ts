import axios from 'axios';
import { config } from '../core/config';
import { AppError, ERROR_CODES } from '../core/errors';
import { logger } from '../core/logger';
import { WhisperLanguage } from '../types/translation';

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

function languageLabel(lang: WhisperLanguage): string {
  switch (lang) {
    case 'en':
      return 'English';
    case 'ru':
      return 'Russian';
    default:
      return 'auto';
  }
}

export async function translateText(
  text: string,
  source: WhisperLanguage,
  target: WhisperLanguage
): Promise<string> {
  if (!config.OPENAI_API_KEY) {
    throw new AppError(
      ERROR_CODES.ERR_TRANSLATION_FAILED,
      'OpenAI API key missing for translation',
      { hint: 'Set OPENAI_API_KEY in environment' }
    );
  }

  if (target === 'unknown') {
    throw new AppError(
      ERROR_CODES.ERR_TRANSLATION_FAILED,
      'Target language is not defined'
    );
  }

  const model = config.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini';

  try {
    const response = await axios.post(
      OPENAI_CHAT_URL,
      {
        model,
        response_format: { type: 'text' },
        messages: [
          {
            role: 'system',
            content: 'You are a professional translator. Translate the user text to the requested language preserving meaning. Return only the translated text without explanations.',
          },
          {
            role: 'user',
            content: `Source language: ${languageLabel(source)}\nTarget language: ${languageLabel(target)}\n\nText:\n${text}`,
          },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
        },
        timeout: 120000,
      }
    );

    const data = response.data || {};
    const translated = data.choices?.[0]?.message?.content;
    if (!translated || typeof translated !== 'string') {
      throw new Error('No translation returned');
    }

    return translated.trim();
  } catch (error) {
    logger.error('Text translation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AppError(
      ERROR_CODES.ERR_TRANSLATION_FAILED,
      'Translation request failed',
      { cause: error }
    );
  }
}
