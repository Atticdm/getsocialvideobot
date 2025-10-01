# TikTok Integration

## Overview

TikTok support has been successfully integrated into the video-bot project following the same architecture pattern as existing providers (Facebook, Instagram, LinkedIn, YouTube).

## Implementation Details

### Files Created
- `video-bot/src/providers/tiktok/detect.ts` - URL detection for TikTok
- `video-bot/src/providers/tiktok/download.ts` - Download and metadata fetching

### Files Modified
- `video-bot/src/providers/index.ts` - Added TikTok to provider registry
- `video-bot/src/core/config.ts` - Added `TIKTOK_COOKIES_B64` configuration
- `video-bot/src/web/server.ts` - Updated UI to mention TikTok
- `video-bot/README.md` - Updated supported platforms list

## Supported URLs

The provider detects and handles the following TikTok URL formats:
- `https://www.tiktok.com/@username/video/1234567890`
- `https://tiktok.com/@username/video/1234567890`
- `https://m.tiktok.com/@username/video/1234567890` (mobile)
- `https://vm.tiktok.com/abc123/` (short links)
- `https://vt.tiktok.com/xyz456/` (short links)

## Features

### Download Strategy
1. **Multiple Attempts**: Like other providers, tries multiple user agents (mobile first, then desktop)
2. **Cookie Support**: Optional `TIKTOK_COOKIES_B64` for age-restricted or private content
3. **Geo-Bypass**: Respects `GEO_BYPASS_COUNTRY` setting
4. **Format Selection**: Prefers MP4 format for best compatibility
5. **Error Mapping**: Comprehensive error handling with user-friendly messages

### Error Handling
The provider maps yt-dlp errors to standardized error codes:
- `ERR_PRIVATE_OR_RESTRICTED` - Private or login-required videos
- `ERR_GEO_BLOCKED` - Geo-restricted content
- `ERR_FETCH_FAILED` - HTTP errors, rate limiting
- `ERR_UNSUPPORTED_URL` - Invalid or unparseable URLs
- `ERR_INTERNAL` - Other errors

## Configuration

### Environment Variables

#### TIKTOK_COOKIES_B64 (optional)
Base64-encoded Netscape cookies.txt for TikTok. Required for:
- Age-restricted videos
- Private content
- Region-locked videos (in combination with geo-bypass)

**How to generate:**
```bash
# 1. Export cookies from your browser (Netscape format)
# 2. Base64-encode the file
base64 -w0 tiktok_cookies.txt

# 3. Set in environment
export TIKTOK_COOKIES_B64="<base64_string>"
```

#### GEO_BYPASS_COUNTRY (optional)
Two-letter country code (e.g., `US`, `GB`, `JP`) to bypass geo-restrictions.

```bash
export GEO_BYPASS_COUNTRY=US
```

## Testing

### Detection Test
```bash
cd video-bot
npm run build
node test-tiktok.js
```

Expected output:
```
✅ https://www.tiktok.com/@username/video/1234567890
   → Provider: tiktok
✅ https://vm.tiktok.com/abc123/
   → Provider: tiktok
```

### Integration Test
```bash
cd video-bot
npm run build
PORT=3000 npm run start:web &
node test-integration.js
```

## Architecture Consistency

The TikTok provider follows the exact same pattern as existing providers:

1. **Detection Module** (`detect.ts`)
   - Single exported function `isTikTokUrl(url: string): boolean`
   - URL validation and hostname checking

2. **Download Module** (`download.ts`)
   - `downloadTikTokVideo()` - Main download function
   - `fetchTikTokMetadata()` - Metadata extraction
   - Helper functions for URL normalization and error mapping
   - Cookie preparation
   - Multiple attempt strategies

3. **Integration** (`index.ts`)
   - Added to `ProviderName` type union
   - Registered in `detectProvider()` function
   - Mapped in `getProvider()` switch statement

## Known Limitations

1. **Geo-Restrictions**: Some TikTok videos are region-locked
   - Solution: Use `GEO_BYPASS_COUNTRY` or cookies

2. **Age-Restricted Content**: Requires authentication
   - Solution: Provide `TIKTOK_COOKIES_B64`

3. **Private Videos**: Cannot be downloaded without proper authentication
   - Solution: Use cookies from authenticated session

4. **Rate Limiting**: TikTok may rate-limit requests
   - Built-in retry logic helps mitigate this

## Compatibility

✅ **No Breaking Changes**
- All existing providers (Facebook, Instagram, LinkedIn, YouTube) remain fully functional
- No changes to public API or behavior
- Backward compatible configuration

## Production Deployment

### Railway Setup
Add the following environment variable if needed:
```
TIKTOK_COOKIES_B64=<base64_encoded_cookies>
GEO_BYPASS_COUNTRY=US
```

### Docker
No changes needed - yt-dlp already supports TikTok out of the box.

## Future Enhancements

Potential improvements:
1. **Quality Selection**: Allow users to choose video quality
2. **Playlist Support**: Download multiple videos from a user's profile
3. **Watermark Removal**: Investigate watermark-free downloads
4. **Live Stream Support**: Handle live TikTok streams
5. **Sound Downloads**: Support downloading TikTok sounds/audio

## Maintenance Notes

- yt-dlp handles TikTok API changes automatically via updates
- Keep `yt-dlp` updated in production environment
- Monitor error rates for geo-blocking patterns
- Consider implementing IP rotation if rate-limiting becomes an issue

## Testing Checklist

- [x] URL detection for all TikTok formats
- [x] Provider registration and integration
- [x] TypeScript compilation without errors
- [x] Other providers still work (regression test)
- [x] Web UI updated
- [x] README updated
- [x] Configuration schema extended
- [x] Error handling implemented
- [x] Cookie support added

## Version History

- **2025-10-01**: Initial TikTok integration
  - Full provider implementation
  - Documentation added
  - Tests created
  - Production ready

