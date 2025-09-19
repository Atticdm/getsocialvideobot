Debug Playbook (Web + Bot)

Quick Checks
- Ensure yt-dlp and ffmpeg are present in the runtime (Dockerfile installs both).
- For Nixpacks deployments (if used): NIXPACKS_PKGS="yt-dlp ffmpeg".
- APP_MODE=web on Railway for the web service.

Web (Fastify)
1) Use the atomic endpoint
   - GET /download_video?url=<encoded>
   - This downloads → sets headers → streams → cleans up, within a single request.
2) Logs to watch
   - "Starting ... video download"
   - "Command executed successfully" / "... downloaded successfully"
   - "download_video failed { message, code, details }"
3) If 500 on streaming
   - You should not see /api/start or /file/:id anymore from the UI.
   - Check stat/log headers then stream errors. Client aborts are logged as warn and not fatal.

YouTube specifics
- If attempts fail:
  - Look for: "yt-dlp attempt failed (youtube) { attempt, code, stderrPreview }".
  - Common messages → action:
    - "Sign in / age" → set YOUTUBE_COOKIES_B64
    - "HTTP Error 403" → Referer/UA already added; try GEO_BYPASS_COUNTRY=US; if persists, proxy needed
    - "429" → rate-limited; backoff/region change
    - "no video formats" → formats blocked; flexible fallback is enabled

Bot (Telegraf)
- Entry: video-bot/src/bot/index.ts
- Commands: /download <url> calls provider.download → ensureBelowLimit → replyWithDocument.
- Works independently of web.

Provider Debug Tips
- Increase logs: set LOG_LEVEL=debug (adds -v to yt-dlp and argument dumps).
- Inspect stderrPreview to diagnose exact cause; consider adding cookies via *_COOKIES_B64.

