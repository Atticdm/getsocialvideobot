Project Context Snapshot

Last updated: 2025-10-20

Overview
- Repo root: getsocialvideobot
- Main app: `video-bot` (TypeScript, Telegraf bot + Fastify web server)
- Providers: Facebook, Instagram, LinkedIn, YouTube, TikTok, Sora (yt-dlp + ffmpeg)
- Status: production-ready, deployed on Railway. Supports Telegram bot + web downloader.

Key Components
- Bot entry: `video-bot/src/bot/index.ts`
- Menu & intents: `video-bot/src/bot/telegraf.ts`
- Translation command pipeline: `video-bot/src/bot/commands/translate.ts`
- Web service: `video-bot/src/web/server.ts` (GET `/download_video?url=...`)
- Providers registry: `video-bot/src/providers/index.ts`
- ElevenLabs/Hume workflows: `video-bot/src/workflows/reelTranslate.ts`
- Core utilities: `video-bot/src/core/*`

Environment & Config
- `.env` (local), Railway variables in production.
- Important keys:
  - `BOT_TOKEN`, `ENABLE_REEL_TRANSLATION`
  - `FFMPEG_PATH` (Railway: `/usr/bin/ffmpeg`)
  - `*_COOKIES_B64` for providers (Facebook/Instagram/LinkedIn/YT/TikTok/Sora)
  - `ELEVENLABS_API_KEY`, `ELEVENLABS_TERMINATOR_VOICE_RU/EN`, `ELEVENLABS_TTS_MODEL_ID`
  - `OPENAI_API_KEY`, `HUME_API_KEY`
  - `LALAL_API_KEY` for stem separation

Telegram Bot UX (2025-10)
- Главное меню:  
  `🌐 Перевести видео` → выбрать направление (EN→RU/ RU→EN) → выбрать тип перевода:
    - `🚀` Hume (быстрый)
    - `💎` ElevenLabs dubbing
    - `🎯` Голос Терминатора (TTS через ElevenLabs)
  `🎙 Озвучить видео` → выбрать язык оригинала (RU/EN) → выбрать голос (Terminator RU/EN) → переозвучка без перевода.
- На каждом шаге клавиатура имеет `⬅️ Назад` и `Отмена` (`/cancel`).
- `/translate <url> [direction] [engine|terminator-ru|…]` остаётся универсальной командой.

Translation / Voice Pipelines
- Instagram reels pipeline: download → audio extraction → LALAL stem separation → выбранный режим:
  - Hume: Python анализ (`scripts/hume_analyze.py`), Whisper transcription, GPT translate, Hume TTS, ffmpeg mix.
  - ElevenLabs dubbing (legacy): `/v1/dubbing` endpoint.
  - ElevenLabs Terminator TTS: Whisper сегменты → ElevenLabs TTS → длительность выравнивается через `ffprobe` + `ffmpeg atempo` (скорость ≤1.3x).
  - Voice mode (identity): пропускаем translateText, используем выбранный голос и язык.
- Сегменты генерируются из Whisper (`response_format=verbose_json`), мелкие сегменты объединяются.

Recent Updates (Oct 2025)
- Added Terminator RU/EN voices with separate flow; integrates ElevenLabs TTS (text-to-speech) and tempo adjustments.
- Sequential TTS to avoid 429 rate limits; retry with backoff (1/2/4s).
- Menu refactor to two primary flows, improved `/cancel` handling, slash commands now bypass text handler.
- `getAudioDuration` helper via ffprobe.

Web Downloader
- Express server serves `/download_video`, storing temp files in `/tmp`.
- Cron cleans `/tmp` every 15 min.
- Inline mode uses temp server for file hosting (`video-bot/src/bot/inline`).

Testing & Debugging
- Bot: `cd video-bot && npm run build && npm start`
- Web: `npm run start:web`
- Key logs: look for `runElevenLabsTtsPipeline`, `FFMPEG_PATH`, `yt-dlp`.
- For TTS issues check `ERR_TTS_RATE_LIMIT` logs.

Open Work / Ideas
- Add more custom voices (reuse voice flow – single place to register new voice presets).
- Better error UX for inline mode and web service (range support, progress UI).
- Continue optimizing LALAL integration (possibly optional).
