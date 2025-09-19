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
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export function toUserMessage(error: AppError): string {
  const messages: Record<ErrorCode, string> = {
    [ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED]: '❌ Video is private, age-restricted, or requires login. Try setting YOUTUBE_COOKIES_B64 environment variable with your YouTube cookies.',
    [ERROR_CODES.ERR_GEO_BLOCKED]: '❌ Video is geo-blocked in your region. Try setting GEO_BYPASS_COUNTRY environment variable.',
    [ERROR_CODES.ERR_TOO_LARGE]: '❌ Video file is too large (max 2GB)',
    [ERROR_CODES.ERR_FETCH_FAILED]: '❌ Failed to fetch video. Please try again later.',
    [ERROR_CODES.ERR_UNSUPPORTED_URL]: '❌ Unsupported URL format or video not found',
    [ERROR_CODES.ERR_INTERNAL]: '❌ Internal server error. Please try again or contact support.',
    [ERROR_CODES.ERR_FILE_NOT_FOUND]: '❌ Temporary file missing during processing',
  };

  return `${messages[error.code as ErrorCode] || 'Unknown error'} (${error.code})`;
}
