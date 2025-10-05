# Video Bot

A Telegram bot that downloads public videos from multiple platforms and sends them back to users as files.

## Features

- Download public Facebook videos using yt-dlp
- Send videos as Telegram documents
- Rate limiting (max 3 concurrent downloads per user)
- Comprehensive error handling with user-friendly messages
- Modular architecture supporting multiple video providers
- Optional Instagram Reels translation pipeline (Whisper -> GPT -> Hume TTS)
- Structured logging with Pino
- TypeScript with strict mode
- Docker support
- PM2 process management

## Requirements

- Node.js LTS (20.10.0+)
- nvm (Node Version Manager) - recommended
- yt-dlp
- ffmpeg (required for translation workflow, optional otherwise)
- Telegram Bot Token

## Installation

### Quick Setup (Recommended)

1. Clone the repository:
```bash
git clone <repository-url>
cd video-bot
```

2. Run the setup script:
```bash
# If you have nvm installed (recommended)
./setup.sh
# or
npm run setup

# If you don't have nvm, use basic setup
./setup-basic.sh
```

3. Edit `.env` file and set your `BOT_TOKEN`

### Manual Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd video-bot
```

2. Set up Node.js environment (recommended):
```bash
# Using nvm (Node Version Manager)
nvm use

# Or manually install Node.js 20.10.0+
node --version  # Should be 20.10.0 or higher
```

3. Install dependencies:
```bash
npm install
```

4. Set up environment variables:
```bash
cp .env.example .env
# Edit .env and set your BOT_TOKEN
```

5. Build the project:
```bash
npm run build
```

## Configuration

Create a `.env` file with the following variables:

```env
BOT_TOKEN=your_telegram_bot_token_here
NODE_ENV=development
DOWNLOAD_DIR=./.tmp
MAX_FILE_MB=1950
LOG_LEVEL=info
# Enable reel translation (optional)
ENABLE_REEL_TRANSLATION=0
OPENAI_API_KEY=
OPENAI_WHISPER_MODEL=gpt-4o-mini-transcribe
OPENAI_TRANSLATE_MODEL=gpt-4o-mini
HUME_API_KEY=
HUME_CLIENT_SECRET=
HUME_VOICE_ID=octave-2-evi
HUME_AUDIO_FORMAT=wav
#FFMPEG_PATH=/usr/bin/ffmpeg
```

### Environment Variables

- `BOT_TOKEN` (required): Your Telegram bot token from @BotFather
- `NODE_ENV`: Environment mode (`development` or `production`)
- `DOWNLOAD_DIR`: Directory for temporary files (default: `./.tmp`)
- `MAX_FILE_MB`: Maximum file size in MB (default: 1950)
- `LOG_LEVEL`: Logging level (default: `info`)
- `ENABLE_REEL_TRANSLATION`: Set to `1` to enable Instagram Reels translation workflow
- `OPENAI_API_KEY`: Required when translation is enabled (Whisper + GPT models)
- `OPENAI_WHISPER_MODEL` / `OPENAI_TRANSLATE_MODEL`: Model overrides for transcription/translation
- `HUME_API_KEY` / `HUME_CLIENT_SECRET`: Credentials for Hume Octave 2 TTS
- `HUME_VOICE_ID`: Default Hume voice for dubbing (default: `octave-2-evi`)
- `HUME_AUDIO_FORMAT`: Output audio format for TTS (default: `wav`)
- `FFMPEG_PATH`: Optional absolute path to ffmpeg binary if not in PATH
- `FACEBOOK_COOKIES_B64` (optional): Base64-encoded contents of a Netscape `cookies.txt` file for Facebook. Use this if certain videos require login in your region. To supply:
  1. Export cookies from your browser to `cookies.txt` (Netscape format)
  2. Base64-encode the file: `base64 -w0 cookies.txt`
  3. Set the value as `FACEBOOK_COOKIES_B64` in your deploy platform

## Usage

### Development

```bash
npm run dev
```

### Web (local)

```bash
npm run build
PORT=3000 npm run start:web
# open http://localhost:3000
```

### Production

```bash
npm run build
npm start
```

### PM2

```bash
npm run build
pm2 start ecosystem.config.cjs
```

### Docker

```bash
# Build image
docker build -t video-bot .

# Run bot
docker run -d --name video-bot \
  -e BOT_TOKEN=your_bot_token \
  -v $(pwd)/logs:/app/logs \
  video-bot

# Run web
docker run -d --name video-web -p 3000:3000 \
  -e APP_MODE=web -e PORT=3000 \
  video-bot
```

### Railway (Web)

- Create a new Railway service from this repo with Root Directory `video-bot`.
- Build: `npm ci && npm run build`
- Start: `APP_MODE=web PORT=3000 npm start` (or `npm run start:web` if using Nixpacks).
- Set environment variables for providers as needed (e.g., `GEO_BYPASS_COUNTRY`, `*_COOKIES_B64`).
- Open the service URL and paste a video link.

## Bot Commands

- `/start` - Show welcome message and instructions
- `/help` - Display help information and usage examples
- `/status` - Check bot status, yt-dlp version, ffmpeg availability, and disk space
- `/download <url>` - Download a supported video in the original language
- `/translate <url> [en-ru|ru-en|auto]` - Translate Instagram Reel audio and return a dubbed version (requires translation env vars)

### Examples

```
/download https://www.facebook.com/watch/?v=123456789
/download https://fb.watch/abc123def/
/translate https://www.instagram.com/reel/XXXXXXXXXXX/ en-ru
```

### Translation Workflow

- Instagram Reels only (English ↔ Russian)
- Pipeline: download → Whisper transcription → GPT translation → Hume Octave 2 TTS → ffmpeg remux
- Detailed setup guide: [docs/REELS_TRANSLATION_SETUP.md](../docs/REELS_TRANSLATION_SETUP.md)

## Supported Platforms

Currently supports:
- Facebook (facebook.com, fb.watch, m.facebook.com)
- Instagram (instagram.com, instagr.am)
- LinkedIn (linkedin.com)
- YouTube (youtube.com, youtu.be)
- TikTok (tiktok.com, vm.tiktok.com, vt.tiktok.com)
- Sora (sora.chatgpt.com)

## Error Codes

The bot returns user-friendly error messages with machine-readable codes:

- `ERR_PRIVATE_OR_RESTRICTED` - Video is private or restricted
- `ERR_GEO_BLOCKED` - Video is geo-blocked in your region
- `ERR_TOO_LARGE` - Video file exceeds size limit
- `ERR_FETCH_FAILED` - Failed to fetch video from source
- `ERR_UNSUPPORTED_URL` - Unsupported URL format
- `ERR_INTERNAL` - Internal server error

## Architecture

```
src/
├── bot/
│   ├── index.ts          # Main bot setup and command registration
│   └── commands/         # Bot command handlers
├── core/                 # Core utilities
│   ├── config.ts         # Configuration management
│   ├── logger.ts         # Logging setup
│   ├── errors.ts         # Error handling and codes
│   ├── fs.ts            # File system utilities
│   ├── exec.ts          # Command execution wrapper
│   ├── size.ts          # File size utilities
│   └── rateLimit.ts     # Rate limiting
├── providers/           # Video provider implementations
│   ├── index.ts         # Provider registry
│   └── facebook/        # Facebook provider
└── ui/                  # User interface components
    └── keyboard.ts      # Keyboard layouts
```

## Logging

- Development: Pretty-printed logs to console
- Production: Structured JSON logs to files
  - `logs/app.log` - All logs
  - `logs/error.log` - Error logs only

## Rate Limiting

- Maximum 3 concurrent downloads per user
- Additional requests are queued
- Prevents abuse and resource exhaustion

## Security

- Temporary files are automatically cleaned up
- No persistent storage of downloaded videos
- Input validation for URLs
- Rate limiting to prevent abuse

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Troubleshooting

### Common Issues

1. **Bot not responding**: Check BOT_TOKEN in .env file
2. **Download fails**: Ensure yt-dlp is installed and accessible
3. **File too large**: Adjust MAX_FILE_MB in configuration
4. **Rate limited**: Wait for current downloads to complete

### Logs

Check logs for detailed error information:
```bash
tail -f logs/app.log
tail -f logs/error.log
```

### Status Check

Use `/status` command to verify:
- Bot version
- yt-dlp availability
- ffmpeg availability
- Free disk space
- Uptime
