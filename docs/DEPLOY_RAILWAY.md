Railway Deploy Guide (Web & Bot)

Web Service
- Root Directory: video-bot
- Service Type: Web
- Environment:
  - APP_MODE=web
  - PORT=3000
  - LOG_LEVEL=info (or debug)
  - Optional: GEO_BYPASS_COUNTRY=US
  - Optional: *_COOKIES_B64 as needed (FACEBOOK_/INSTAGRAM_/LINKEDIN_/YOUTUBE_)
- Dockerfile: already installs ffmpeg + yt-dlp
- Start: Dockerfile CMD uses APP_MODE; for Nixpacks use Start: npm run start:web
- Endpoint to use: /download_video?url=<encoded>

Bot Service (optional separate service)
- APP_MODE not required; BOT_TOKEN required
- Start: npm start (node dist/bot/index.js)

Notes
- Avoid legacy /api/start → /file/:id flow for web; use /download_video.
- If YouTube restricted: set YOUTUBE_COOKIES_B64.

