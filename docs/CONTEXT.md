Project Context Snapshot (for new chat)

Last updated: $(date)

Overview
- Repo root: getsocialvideobot
- Main app: video-bot (TypeScript, Telegraf bot + Fastify web)
- Providers implemented: Facebook, Instagram, LinkedIn, YouTube (yt-dlp + ffmpeg)
- Bot works reliably; web service under active tuning (YouTube especially)

Key Code Paths
- Bot entry: video-bot/src/bot/index.ts
- Web server: video-bot/src/web/server.ts
  - New atomic endpoint: GET /download_video?url=...
  - Legacy endpoints kept: /api/start, /status, /file/:id (not used by UI anymore)
- Providers
  - Registry: video-bot/src/providers/index.ts
  - YouTube: video-bot/src/providers/youtube/download.ts (MeTube-style attempts)
  - Others: facebook/instagram/linkedin
- Core utils: video-bot/src/core/* (config, logger, exec, fs, size, errors)
- Shared provider utils: video-bot/src/providers/utils.ts, cookies.ts

Environment & Config
- video-bot/.env (local only; not committed). Railway variables used in prod.
- APP_MODE: 'bot' or 'web' (web for Fastify server)
- PORT: default 3000
- LOG_LEVEL: info|debug|trace (debug prints yt-dlp args in logs)
- GEO_BYPASS_COUNTRY: e.g. US (helps with geo restrictions)
- *_COOKIES_B64: FACEBOOK_/INSTAGRAM_/LINKEDIN_/YOUTUBE_ (base64 Netscape cookies.txt)
- DEBUG_YTDLP/ SKIP_COOKIES (optional toggles)

Current State
- Web service now serves downloads via a single request (GET /download_video), avoiding ephemeral FS/state issues on Railway.
- YouTube provider attempts (in order):
  1) Standard Merge: bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best + merge-to-mp4
  2) Mobile/Shorts: mobile UA + android client + best[ext=mp4]/best
  3) Flexible fallback: bestvideo*+bestaudio/best + merge-to-mp4
  4) Flexible + cookies (if configured)
- All attempts set proper Referer and User-Agent; --ignore-config included.
- File streaming uses Fastify reply.send(stream) with headers and delayed cleanup.

Recent Fixes (Latest Update)
1) Fixed web service file streaming issue:
   - Files were being deleted before streaming completed
   - Now cleanup happens after streaming is finished
2) Enhanced YouTube provider with more download strategies:
   - Added TV client, iOS client attempts
   - Better error detection for age-restricted content
   - Improved error messages with setup instructions
3) Added comprehensive YouTube cookies setup guide

Open Issues / Next Steps
1) Web YouTube edge cases may still fail due to:
   - Age restriction → set YOUTUBE_COOKIES_B64 (see docs/YOUTUBE_COOKIES_SETUP.md)
   - Geo/rate limits → set GEO_BYPASS_COUNTRY / use proxy (future)
   - Formats unsupported in a region → review stderrPreview in logs
2) Enhance /download_video with Range support (optional) if resume is needed.
3) Improve UI feedback (progress, friendly ERR_* hints).

How to Continue Debugging Quickly
- Redeploy web on Railway, then test:
  - https://<service>/download_video?url=<encoded_url>
  - Prefer incognito to avoid stale cached HTML.
- Check Deploy Logs around lines containing:
  - "yt-dlp attempt failed (youtube)" (stderrPreview shows exact cause)
  - "download_video failed" with message/code/details
- For bot, run locally: cd video-bot && npm run build && npm start (ensure BOT_TOKEN).

Useful Files to Read First
- video-bot/src/web/server.ts
- video-bot/src/providers/youtube/download.ts
- video-bot/src/core/exec.ts (captures stdout/stderr/exit codes)
- video-bot/src/core/config.ts (APP_MODE/BOT_TOKEN validation; env schema)

