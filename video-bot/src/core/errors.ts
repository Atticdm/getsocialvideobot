export class AppError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export const ERROR_CODES = {
  ERR_PRIVATE_OR_RESTRICTED: 'ERR_PRIVATE_OR_RESTRICTED',
  ERR_GEO_BLOCKED: 'ERR_GEO_BLOCKED',
  ERR_TOO_LARGE: 'ERR_TOO_LARGE',
  ERR_FETCH_FAILED: 'ERR_FETCH_FAILED',
  ERR_UNSUPPORTED_URL: 'ERR_UNSUPPORTED_URL',
  ERR_INTERNAL: 'ERR_INTERNAL',
  ERR_FILE_NOT_FOUND: 'ERR_FILE_NOT_FOUND',
  ERR_TRANSLATION_NOT_SUPPORTED: 'ERR_TRANSLATION_NOT_SUPPORTED',
  ERR_TRANSCRIPTION_FAILED: 'ERR_TRANSCRIPTION_FAILED',
  ERR_TRANSLATION_FAILED: 'ERR_TRANSLATION_FAILED',
  ERR_TTS_FAILED: 'ERR_TTS_FAILED',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export function toUserMessage(error: AppError): string {
  const messages: Record<ErrorCode, string> = {
    [ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED]: '❌ Video is private, age-restricted, or requires login. This can also be caused by geo-restrictions. Try setting YOUTUBE_COOKIES_B64 or GEO_BYPASS_COUNTRY environment variables.',
    [ERROR_CODES.ERR_GEO_BLOCKED]: '❌ Video is geo-blocked in your region. Try setting GEO_BYPASS_COUNTRY environment variable.',
    [ERROR_CODES.ERR_TOO_LARGE]: '❌ Video file is too large (max 2GB)',
    [ERROR_CODES.ERR_FETCH_FAILED]: '❌ Failed to fetch video. Please try again later.',
    [ERROR_CODES.ERR_UNSUPPORTED_URL]: '❌ Unsupported URL format or video not found',
    [ERROR_CODES.ERR_INTERNAL]: '❌ Internal server error. Please try again or contact support.',
    [ERROR_CODES.ERR_FILE_NOT_FOUND]: '❌ Temporary file missing during processing',
    [ERROR_CODES.ERR_TRANSLATION_NOT_SUPPORTED]: '❌ Перевод для этой ссылки пока не поддерживается',
    [ERROR_CODES.ERR_TRANSCRIPTION_FAILED]: '❌ Не удалось распознать речь. Попробуйте ещё раз позже.',
    [ERROR_CODES.ERR_TRANSLATION_FAILED]: '❌ Не удалось выполнить перевод текста. Попробуйте позже.',
    [ERROR_CODES.ERR_TTS_FAILED]: '❌ Не удалось озвучить текст. Попробуйте позже.',
  };

  return `${messages[error.code as ErrorCode] || 'Unknown error'} (${error.code})`;
}
