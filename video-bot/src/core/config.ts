import { config } from 'dotenv';
import { z } from 'zod';

// Load environment variables
config();

const configSchema = z.object({
  APP_MODE: z.enum(['bot', 'web']).default('bot'),
  BOT_TOKEN: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  DOWNLOAD_DIR: z.string().default('./.tmp'),
  MAX_FILE_MB: z.coerce.number().positive().default(1950),
  FFMPEG_PATH: z.string().optional().default('ffmpeg'),
  PYTHON_PATH: z.string().optional().default('python3'),
  PUBLIC_URL: z.string().optional().default(''),
  TEMP_SERVER_URL: z.string().optional().default(''),
  TEMP_SERVER_SECRET: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().optional().default(''),
  CACHE_PREFIX: z.string().optional().default('yeet:'),
  CACHE_TTL_SECONDS: z.coerce.number().positive().optional().default(3600),
  DATABASE_URL: z.string().optional().default(''),
  DB_POOL_MIN: z.coerce.number().int().positive().optional().default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().optional().default(10),
  ADMIN_USER_IDS: z.string().optional().default(''), // "123456789,987654321"
  PAYMENT_ENABLED: z.coerce.boolean().optional().default(true),
  STARS_PACKAGE_CREDITS: z.coerce.number().int().positive().optional().default(10),
  STARS_PACKAGE_PRICE: z.coerce.number().int().positive().optional().default(500), // Stars
  REDSYS_ENABLED: z.coerce.boolean().optional().default(false),
  REDSYS_PROVIDER_TOKEN: z.string().optional().default(''), // Provider token от BotFather
  REDSYS_PACKAGE_CREDITS: z.coerce.number().int().positive().optional().default(10),
  REDSYS_PACKAGE_PRICE_RUB: z.coerce.number().int().positive().optional().default(50000), // Рубли в копейках (500 руб = 50000 копеек)
  REDSYS_CURRENCY: z.string().optional().default('RUB'), // RUB, EUR, USD
  POSTHOG_ENABLED: z.union([z.boolean(), z.string()]).optional(),
  POSTHOG_API_KEY: z.string().optional().default(''),
  POSTHOG_HOST: z.string().optional().default('https://us.i.posthog.com'),
  // Optional: base64-encoded Netscape cookies.txt for Facebook
  FACEBOOK_COOKIES_B64: z.string().optional().default(''),
  // Optional: base64-encoded Netscape cookies.txt for Instagram
  INSTAGRAM_COOKIES_B64: z.string().optional().default(''),
  LINKEDIN_COOKIES_B64: z.string().optional().default(''),
  YOUTUBE_COOKIES_B64: z.string().optional().default(''),
  YOUTUBE_GEO_COUNTRIES: z.string().optional().default(''),
  ARENA_CHANNEL_ID: z.string().optional().default(''),
  ARENA_CHANNEL_URL: z.string().optional().default(''),
  TIKTOK_COOKIES_B64: z.string().optional().default(''),
  SORA_COOKIES_B64: z.string().optional().default(''),
  DEBUG_YTDLP: z.coerce.boolean().optional().default(false),
  SKIP_COOKIES: z.coerce.boolean().optional().default(false),
  // Optional: two-letter country code to try for geo-bypass (e.g. US, NL)
  GEO_BYPASS_COUNTRY: z.string().optional().default(''),
  // Translation workflow configuration
  ENABLE_REEL_TRANSLATION: z.coerce.boolean().optional().default(true),
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_WHISPER_MODEL: z.string().optional().default('whisper-1'),
  OPENAI_TRANSLATE_MODEL: z.string().optional().default('gpt-4o-mini'),
  HUME_API_KEY: z.string().optional().default(''),
  HUME_CLIENT_SECRET: z.string().optional().default(''),
  HUME_VOICE_ID_RU_MALE: z.string().optional().default('40d389b7-dbe2-4f3a-b8b8-3171e3b18f0b'),
  HUME_VOICE_ID_RU_FEMALE: z.string().optional().default('1a2e8cc5-7ca5-4db5-b799-d0e5728f7892'),
  HUME_VOICE_ID_EN_MALE: z.string().optional().default('cb1a4fae-dad5-4729-bd73-a43f570b9117'),
  HUME_VOICE_ID_EN_FEMALE: z.string().optional().default('5bbc32c1-a1f6-44e8-bedb-9870f23619e2'),
  HUME_AUDIO_FORMAT: z.string().optional().default('wav'),
  ELEVENLABS_API_KEY: z.string().optional().default(''),
  ELEVENLABS_TERMINATOR_VOICE_RU: z.string().optional().default(''),
  ELEVENLABS_TERMINATOR_VOICE_EN: z.string().optional().default(''),
  ELEVENLABS_ZHIRINOVSKY_VOICE_RU: z.string().optional().default(''),
  ELEVENLABS_ZHIRINOVSKY_VOICE_EN: z.string().optional().default(''),
  ELEVENLABS_TTS_MODEL_ID: z.string().optional().default('eleven_multilingual_v2'),
  LALAL_API_KEY: z.string().optional().default(''),
});

type BaseConfig = z.infer<typeof configSchema>;
export type Config = BaseConfig & {
  YOUTUBE_GEO_COUNTRIES_LIST: string[];
};

function parseCountryList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{2}$/.test(code));
}

let appConfig: Config;

try {
  const parsed = configSchema.parse(process.env);
  const rawPosthogEnabled = parsed.POSTHOG_ENABLED;
  const posthogEnabled =
    typeof rawPosthogEnabled === 'boolean'
      ? rawPosthogEnabled
      : rawPosthogEnabled === undefined || rawPosthogEnabled.trim().length === 0
        ? true
        : !['0', 'false', 'off', 'no'].includes(rawPosthogEnabled.trim().toLowerCase());

  appConfig = {
    ...parsed,
    POSTHOG_ENABLED: posthogEnabled,
    YOUTUBE_GEO_COUNTRIES_LIST: parseCountryList(parsed.YOUTUBE_GEO_COUNTRIES),
  };
  if (appConfig.APP_MODE === 'bot' && (!appConfig.BOT_TOKEN || appConfig.BOT_TOKEN.length === 0)) {
    console.error('Configuration validation failed:');
    console.error('  BOT_TOKEN: Required in APP_MODE=bot');
    process.exit(1);
  }
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('Configuration validation failed:');
    error.errors.forEach((err) => {
      console.error(`  ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }
  throw error;
}

export { appConfig as config };
